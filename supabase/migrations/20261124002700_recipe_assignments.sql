create table public.customer_product_recipes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.items,
  customer_id uuid references public.customers,
  recipe_version_id uuid not null references public.recipe_approvals(recipe_version_id),
  scope text not null check (scope in ('CLIENTE','PADRAO')),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  starts_at timestamptz not null default statement_timestamp(),
  started_by uuid not null references public.profiles,
  ends_at timestamptz,
  ended_by uuid references public.profiles,
  end_reason text,
  check ((scope = 'CLIENTE' and customer_id is not null) or (scope = 'PADRAO' and customer_id is null)),
  check ((ends_at is null and ended_by is null and end_reason is null)
    or (ends_at is not null and ended_by is not null and nullif(btrim(end_reason),'') is not null))
);
create unique index customer_product_recipes_current_customer_idx
  on public.customer_product_recipes(product_id,customer_id) where ends_at is null and scope = 'CLIENTE';
create unique index customer_product_recipes_current_default_idx
  on public.customer_product_recipes(product_id) where ends_at is null and scope = 'PADRAO';
create index customer_product_recipes_version_idx on public.customer_product_recipes(recipe_version_id);
create index customer_product_recipes_customer_idx on public.customer_product_recipes(customer_id) where customer_id is not null;

alter table public.customer_product_recipes enable row level security;
revoke all on public.customer_product_recipes from public, anon, authenticated;
grant select on public.customer_product_recipes to authenticated;
create policy recipe_assignments_admin_read on public.customer_product_recipes for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR')));

create function purezza_private.save_recipe_assignment(
  target_product uuid, target_customer uuid, rule_scope text, target_version uuid, expected_assignment uuid,
  reason text, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  current_rule uuid;
  result_id uuid;
  applied_at timestamptz;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'Somente Administração pode configurar associações de receita.';
  end if;
  if rule_scope is null or rule_scope not in ('CLIENTE','PADRAO')
    or (rule_scope = 'CLIENTE') is distinct from (target_customer is not null)
    or nullif(btrim(reason),'') is null or length(btrim(reason)) > 500 then
    raise exception using errcode = '22023', message = 'Confira o tipo da associação e a justificativa.';
  end if;
  previous := purezza_private.claim_operation('SALVAR_ASSOCIACAO_RECEITA',request_id,
    jsonb_build_array(target_product,target_customer,rule_scope,target_version,expected_assignment,reason));
  if previous is not null then return previous; end if;

  perform id from public.items where id = target_product and active and classification = 'FABRICACAO_PROPRIA' for update;
  if not found then raise exception using errcode = '22023', message = 'Selecione um produto ativo de fabricação própria.'; end if;

  select id into current_rule from public.customer_product_recipes
    where product_id = target_product and scope = rule_scope and customer_id is not distinct from target_customer
      and ends_at is null;
  if current_rule is distinct from expected_assignment then
    raise exception using errcode = '40001', message = 'A associação mudou. Reabra a regra atual.';
  end if;
  if target_version is null and current_rule is null then
    raise exception using errcode = '22023', message = 'Selecione uma associação vigente para encerrar.';
  end if;
  if target_version is not null then
    perform version.id from public.recipe_versions version
      join public.recipe_approvals approval on approval.recipe_version_id = version.id
      where version.id = target_version and version.status = 'APROVADA' for share of version;
    if not found then raise exception using errcode = '22023', message = 'Selecione uma versão de receita aprovada.'; end if;
    if rule_scope = 'CLIENTE' then
      perform id from public.customers where id = target_customer and active;
      if not found then raise exception using errcode = '22023', message = 'Selecione um cliente ativo.'; end if;
    end if;
  end if;

  applied_at := clock_timestamp();
  if current_rule is not null then
    update public.customer_product_recipes set ends_at=applied_at, ended_by=auth.uid(),
      end_reason=save_recipe_assignment.reason where id=current_rule;
  end if;
  if target_version is not null then
    insert into public.customer_product_recipes(product_id,customer_id,recipe_version_id,scope,reason,starts_at,started_by)
      values(target_product,target_customer,target_version,rule_scope,btrim(reason),applied_at,auth.uid())
      returning id into result_id;
  else
    result_id := current_rule;
  end if;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'SALVAR_ASSOCIACAO_RECEITA',
    jsonb_build_object('produto_id',target_product,'regra_id',result_id,'regra_anterior_id',current_rule,
      'escopo',rule_scope,'encerramento',target_version is null));
  update public.operation_requests set result=result_id
    where actor=auth.uid() and operation='SALVAR_ASSOCIACAO_RECEITA'
      and operation_requests.request_id=save_recipe_assignment.request_id;
  return result_id;
end
$$;

create function purezza_private.resolve_demand_recipe(target_demand uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode consultar a receita associada.';
  end if;
  select jsonb_build_object('assignment_id',association.id,'recipe_version_id',version.id,
    'recipe_name',recipe.name,'recipe_number',version.version,'scope',association.scope)
  into result
  from public.production_demands demand
  join public.orders purchase on purchase.id = demand.order_id
  join public.items item on item.id = demand.item_id and item.active and item.classification = 'FABRICACAO_PROPRIA'
  join public.customer_product_recipes association on association.product_id = demand.item_id and association.ends_at is null
    and (association.scope = 'PADRAO' or association.customer_id = purchase.customer_id)
  join public.recipe_versions version on version.id = association.recipe_version_id and version.status = 'APROVADA'
  join public.recipes recipe on recipe.id = version.recipe_id
  where demand.order_item_id = target_demand
  order by (association.scope = 'CLIENTE') desc limit 1;
  return result;
end
$$;

create function public.save_recipe_assignment(
  target_product uuid, target_customer uuid, rule_scope text, target_version uuid, expected_assignment uuid,
  reason text, request_id uuid
)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.save_recipe_assignment(target_product,target_customer,rule_scope,target_version,expected_assignment,reason,request_id)
$$;
create function public.resolve_demand_recipe(target_demand uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.resolve_demand_recipe(target_demand)
$$;
revoke all on function purezza_private.save_recipe_assignment(uuid,uuid,text,uuid,uuid,text,uuid),
  public.save_recipe_assignment(uuid,uuid,text,uuid,uuid,text,uuid), purezza_private.resolve_demand_recipe(uuid),
  public.resolve_demand_recipe(uuid) from public, anon, authenticated;
grant execute on function purezza_private.save_recipe_assignment(uuid,uuid,text,uuid,uuid,text,uuid),
  public.save_recipe_assignment(uuid,uuid,text,uuid,uuid,text,uuid), purezza_private.resolve_demand_recipe(uuid),
  public.resolve_demand_recipe(uuid) to authenticated;
