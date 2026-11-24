alter table public.recipe_versions drop constraint recipe_versions_status_check;
alter table public.recipe_versions add constraint recipe_versions_status_check
  check (status in ('PENDENTE_VALIDACAO','APROVADA'));

create table public.recipe_approvals (
  recipe_version_id uuid primary key references public.recipe_versions,
  review_version int not null check (review_version > 0),
  approved_by uuid not null references public.profiles,
  approved_at timestamptz not null default statement_timestamp(),
  approval_reference text not null check (length(btrim(approval_reference)) between 1 and 500)
);
alter table public.recipe_approvals enable row level security;
revoke all on public.recipe_approvals from public, anon, authenticated;
grant select on public.recipe_approvals to authenticated;
create policy recipe_approvals_technical_read on public.recipe_approvals for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR','PRODUCAO')));

create function purezza_private.protect_approved_recipe_review()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' and exists (
    select from public.recipe_approvals where recipe_version_id = old.recipe_version_id
  ) then
    raise exception using errcode = '22023', message = 'Uma ficha aprovada é imutável.';
  end if;
  if tg_op <> 'DELETE' and exists (
    select from public.recipe_approvals where recipe_version_id = new.recipe_version_id
  ) then
    raise exception using errcode = '22023', message = 'Uma ficha aprovada é imutável.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
revoke all on function purezza_private.protect_approved_recipe_review() from public, anon, authenticated;
create trigger protect_approved_recipe_review before insert or update or delete on public.recipe_reviews
  for each row execute function purezza_private.protect_approved_recipe_review();
create trigger protect_approved_recipe_ingredients before insert or update or delete on public.recipe_review_ingredients
  for each row execute function purezza_private.protect_approved_recipe_review();
create trigger protect_approved_recipe_source before insert or update or delete on public.recipe_ingredients
  for each row execute function purezza_private.protect_approved_recipe_review();

create function purezza_private.approve_recipe_version(
  target_version uuid, expected_review_version int, reference text, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  review public.recipe_reviews%rowtype;
  line record;
  material_unit text;
  has_water boolean := false;
  water_line boolean;
begin
  perform id from public.profiles where id = auth.uid() and active and can_approve_recipe
    and role in ('ADMINISTRADOR','PRODUCAO') for share;
  if not found then
    raise exception using errcode = '42501', message = 'A aprovação exige um responsável técnico com permissão específica.';
  end if;
  previous := purezza_private.claim_operation('APROVAR_RECEITA',request_id,
    jsonb_build_array(target_version,expected_review_version,reference));
  if previous is not null then return previous; end if;
  if nullif(btrim(reference),'') is null or length(btrim(reference)) > 500 then
    raise exception using errcode = '22023', message = 'Informe a referência da aprovação técnica.';
  end if;

  perform id from public.recipe_versions where id = target_version and status = 'PENDENTE_VALIDACAO' for update;
  if not found then raise exception using errcode = '22023', message = 'Selecione uma versão pendente de validação.'; end if;
  select * into review from public.recipe_reviews where recipe_version_id = target_version;
  if not found or review.edit_version is distinct from expected_review_version then
    raise exception using errcode = '40001', message = 'A ficha mudou ou ainda não foi salva. Reabra a versão atual.';
  end if;
  if review.yield_min is null or review.yield_target is null or review.yield_max is null
    or review.shelf_life_days is null or review.storage_conditions is null
    or review.water_control_reference is null or review.review_reference is null then
    raise exception using errcode = '22023', message = 'Complete rendimento, validade, armazenamento e referências da água e da revisão.';
  end if;

  for line in
    select source.source_name, ingredient.item_id, ingredient.quantity, ingredient.unit, ingredient.stage,
      ingredient.lower_tolerance, ingredient.upper_tolerance, ingredient.technical_reference
    from public.recipe_ingredients source
    left join public.recipe_review_ingredients ingredient
      on ingredient.recipe_version_id = source.recipe_version_id and ingredient.source_ingredient_id = source.id
    where source.recipe_version_id = target_version order by ingredient.item_id,source.ordinal
  loop
    water_line := lower(btrim(line.source_name)) in ('água','agua');
    has_water := has_water or water_line;
    if line.quantity is null or line.unit is null or line.stage is null or line.lower_tolerance is null
      or line.upper_tolerance is null or (not water_line and line.item_id is null) then
      raise exception using errcode = '22023', message = 'Complete insumos, quantidades, unidades, etapas e tolerâncias.';
    end if;
    if lower(line.source_name) ~ '(sorbato|branqueador|ajinomoto)' and line.technical_reference is null then
      raise exception using errcode = '22023', message = 'Informe as referências técnicas dos aditivos.';
    end if;

    if line.item_id is not null then
      select base_unit into material_unit from public.items where id = line.item_id and active
        and classification in ('INSUMO','FARINHA_USO_REVENDA_A_VALIDAR') for share;
      if not found or material_unit is null or not (
        material_unit = line.unit or (material_unit in ('kg','g') and line.unit in ('kg','g'))
        or (material_unit in ('L','mL') and line.unit in ('L','mL'))
      ) then
        raise exception using errcode = '22023', message = 'Há insumo inativo ou com unidade incompatível.';
      end if;
    end if;
  end loop;
  if not has_water then
    raise exception using errcode = '22023', message = 'A ficha precisa registrar a água prevista.';
  end if;

  insert into public.recipe_approvals(recipe_version_id,review_version,approved_by,approval_reference)
    values(target_version,review.edit_version,auth.uid(),btrim(reference));
  update public.recipe_versions set status = 'APROVADA' where id = target_version;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'APROVAR_RECEITA',
    jsonb_build_object('receita_versao_id',target_version,'versao_ficha',review.edit_version));
  update public.operation_requests set result = target_version
    where actor = auth.uid() and operation = 'APROVAR_RECEITA' and operation_requests.request_id = approve_recipe_version.request_id;
  return target_version;
end
$$;

create function public.approve_recipe_version(target_version uuid, expected_review_version int, reference text, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.approve_recipe_version(target_version,expected_review_version,reference,request_id)
$$;
revoke all on function purezza_private.approve_recipe_version(uuid,int,text,uuid),
  public.approve_recipe_version(uuid,int,text,uuid) from public, anon, authenticated;
grant execute on function purezza_private.approve_recipe_version(uuid,int,text,uuid),
  public.approve_recipe_version(uuid,int,text,uuid) to authenticated;

create or replace function public.calculate_production_plan(
  target_demand uuid, target_recipe_version uuid, yield_mode text, simulated_stock_kg numeric
)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  demand public.production_demands%rowtype;
  recipe public.recipe_versions%rowtype;
  selected_yield numeric;
  approved public.recipe_reviews%rowtype;
  net_kg numeric;
  batches numeric;
  flour_per_batch numeric;
  min_output numeric;
  target_output numeric;
  max_output numeric;
  ingredients jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode simular produção.';
  end if;
  if yield_mode is null or yield_mode not in ('MEDIO','CONSERVADOR')
    or simulated_stock_kg is null or not (simulated_stock_kg >= 0 and simulated_stock_kg < 1000000000000)
    or simulated_stock_kg <> round(simulated_stock_kg, 9) then
    raise exception using errcode = '22023', message = 'Confira o cenário e a quantidade hipotética de estoque.';
  end if;

  select * into demand from public.production_demands where order_item_id = target_demand;
  if not found or demand.requested_kg is null then
    raise exception using errcode = '22023', message = 'A demanda precisa ter quantidade conhecida em kg.';
  end if;
  select * into recipe from public.recipe_versions where id = target_recipe_version;
  if not found then
    raise exception using errcode = '22023', message = 'Selecione uma versão de receita.';
  end if;

  if recipe.status = 'APROVADA' then
    select * into strict approved from public.recipe_reviews where recipe_version_id = recipe.id;
    recipe.yield_min := approved.yield_min;
    recipe.yield_target := approved.yield_target;
    recipe.yield_max := approved.yield_max;
  end if;
  selected_yield := case when yield_mode = 'CONSERVADOR' then recipe.yield_min else recipe.yield_target end;
  net_kg := greatest(0, demand.requested_kg - simulated_stock_kg);
  batches := div(net_kg, selected_yield) + case when mod(net_kg, selected_yield) > 0 then 1 else 0 end;
  min_output := batches * recipe.yield_min;
  target_output := batches * recipe.yield_target;
  max_output := batches * recipe.yield_max;

  with effective as (
    select source.source_name,source.ordinal,
      case when recipe.status = 'APROVADA' then verified.quantity else source.quantity end as quantity,
      case when recipe.status = 'APROVADA' then verified.unit else source.unit end as unit
    from public.recipe_ingredients source
    left join public.recipe_review_ingredients verified
      on verified.recipe_version_id = source.recipe_version_id and verified.source_ingredient_id = source.id
    where source.recipe_version_id = recipe.id
  )
  select
    case when bool_and(quantity is not null and unit in ('kg','g')) filter (where lower(btrim(source_name)) = 'farinha de trigo')
      then sum(quantity * case unit when 'kg' then 1 when 'g' then 0.001 end)
        filter (where lower(btrim(source_name)) = 'farinha de trigo') end,
    coalesce(jsonb_agg(jsonb_build_object('name',source_name,'unit',unit,'per_batch',quantity::text,
      'planned_quantity',(quantity * batches)::text) order by ordinal),'[]'::jsonb)
  into flour_per_batch,ingredients from effective;

  return jsonb_build_object(
    'requested_kg', demand.requested_kg::text,
    'net_kg', net_kg::text,
    'simulated_stock_kg', simulated_stock_kg::text,
    'yield_kg', selected_yield::text,
    'batches', batches::text,
    'min_output_kg', min_output::text,
    'target_output_kg', target_output::text,
    'max_output_kg', max_output::text,
    'risk_kg', greatest(0, net_kg - min_output)::text,
    'expected_surplus_kg', greatest(0, batches * selected_yield - net_kg)::text,
    'flour_kg', (flour_per_batch * batches)::text,
    'flour_sacks_25kg', (flour_per_batch * batches / 25)::text,
    'recipe_status', recipe.status,
    'ingredients', ingredients
  );
end
$$;
