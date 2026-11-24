create table public.recipe_reviews (
  recipe_version_id uuid primary key references public.recipe_versions,
  edit_version int not null default 1 check (edit_version > 0),
  yield_min numeric(18,6) check (yield_min > 0),
  yield_target numeric(18,6) check (yield_target > 0 and yield_target >= yield_min),
  yield_max numeric(18,6) check (yield_max > 0 and yield_max >= yield_target and yield_max >= yield_min),
  shelf_life_days int check (shelf_life_days > 0),
  storage_conditions text check (length(storage_conditions) <= 1000),
  water_control_reference text check (length(water_control_reference) <= 500),
  review_reference text check (length(review_reference) <= 500),
  edited_by uuid not null references public.profiles,
  edited_at timestamptz not null default statement_timestamp()
);

alter table public.recipe_ingredients add constraint recipe_ingredient_version_id_unique unique (recipe_version_id,id);

create table public.recipe_review_ingredients (
  recipe_version_id uuid not null references public.recipe_reviews,
  source_ingredient_id uuid not null,
  item_id uuid references public.items,
  quantity numeric(18,6) check (quantity > 0),
  unit text check (unit in ('kg','g','L','mL','un')),
  stage text check (stage in ('PREPARACAO','BATER_MASSA')),
  lower_tolerance numeric(18,6) check (lower_tolerance >= 0 and lower_tolerance <= quantity),
  upper_tolerance numeric(18,6) check (upper_tolerance >= 0),
  technical_reference text check (length(technical_reference) <= 500),
  primary key (recipe_version_id,source_ingredient_id),
  foreign key (recipe_version_id,source_ingredient_id) references public.recipe_ingredients(recipe_version_id,id)
);
create index recipe_review_ingredients_item_idx on public.recipe_review_ingredients(item_id);

do $$
declare relation text;
begin
  foreach relation in array array['recipe_reviews','recipe_review_ingredients'] loop
    execute format('alter table public.%I enable row level security',relation);
    execute format('revoke all on public.%I from public, anon, authenticated',relation);
    execute format('grant select on public.%I to authenticated',relation);
    execute format('create policy recipe_review_technical_read on public.%I for select to authenticated
      using ((select purezza_private.has_role(''ADMINISTRADOR'',''PRODUCAO'')))',relation);
  end loop;
end
$$;

create function purezza_private.save_recipe_review(
  target_version uuid, expected_version int, input jsonb, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  saved uuid;
  yield_values numeric[];
  qty numeric;
  low numeric;
  high numeric;
  stage_name text;
  unit_name text;
  ingredient_id uuid;
  material uuid;
  material_unit text;
  entry jsonb;
  ingredient_count int;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'Somente Administração pode editar fichas técnicas.';
  end if;
  if jsonb_typeof(input) is distinct from 'object' or jsonb_typeof(input->'ingredients') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Informe os dados da ficha técnica.';
  end if;
  previous := purezza_private.claim_operation('SALVAR_REVISAO_RECEITA',request_id,
    to_jsonb(encode(sha256(convert_to(jsonb_build_array(target_version,expected_version,input)::text,'UTF8')),'hex')));
  if previous is not null then return previous; end if;
  perform id from public.recipe_versions where id = target_version and status = 'PENDENTE_VALIDACAO' for update;
  if not found then raise exception using errcode = '22023', message = 'Selecione uma receita pendente de validação.'; end if;

  select count(*) into ingredient_count from public.recipe_ingredients where recipe_version_id = target_version;
  if ingredient_count <> jsonb_array_length(input->'ingredients') or exists (
    select from jsonb_array_elements(input->'ingredients') as entries(line)
    group by (line->>'source_ingredient_id')::uuid having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'A ficha deve corresponder aos ingredientes da versão original.';
  end if;
  yield_values := array[nullif(input->>'yield_min','')::numeric,nullif(input->>'yield_target','')::numeric,
    nullif(input->>'yield_max','')::numeric];
  if exists(select from unnest(yield_values) quantity
    where not (quantity > 0 and quantity < 1000000000000) or quantity <> round(quantity,6)) then
    raise exception using errcode = '22023', message = 'Confira os valores de rendimento.';
  end if;

  insert into public.recipe_reviews(recipe_version_id,yield_min,yield_target,yield_max,shelf_life_days,
    storage_conditions,water_control_reference,review_reference,edited_by)
  select target_version,yield_values[1],yield_values[2],yield_values[3],
    nullif(input->>'shelf_life_days','')::int,nullif(btrim(input->>'storage_conditions'),''),
    nullif(btrim(input->>'water_control_reference'),''),nullif(btrim(input->>'review_reference'),''),auth.uid()
  where expected_version is null or exists(select from public.recipe_reviews where recipe_version_id = target_version)
  on conflict(recipe_version_id) do update set
    yield_min = excluded.yield_min,yield_target = excluded.yield_target,yield_max = excluded.yield_max,
    shelf_life_days = excluded.shelf_life_days,storage_conditions = excluded.storage_conditions,
    water_control_reference = excluded.water_control_reference,review_reference = excluded.review_reference,
    edited_by = excluded.edited_by,edited_at = statement_timestamp(),edit_version = recipe_reviews.edit_version + 1
  where recipe_reviews.edit_version = expected_version
  returning recipe_version_id into saved;
  if saved is null then raise exception using errcode = '40001', message = 'A ficha mudou. Reabra a versão atual.'; end if;

  for entry in select value from jsonb_array_elements(input->'ingredients') order by value->>'item_id' loop
    ingredient_id := (entry->>'source_ingredient_id')::uuid;
    material := nullif(entry->>'item_id','')::uuid;
    qty := nullif(entry->>'quantity','')::numeric;
    low := nullif(entry->>'lower_tolerance','')::numeric;
    high := nullif(entry->>'upper_tolerance','')::numeric;
    stage_name := nullif(entry->>'stage','');
    unit_name := nullif(entry->>'unit','');
    if qty <= 0 or (qty is not null and unit_name is null)
      or (qty is null and (low is not null or high is not null))
      or exists(select from unnest(array[qty,low,high]) quantity
        where not (quantity >= 0 and quantity < 1000000000000) or quantity <> round(quantity,6)) then
      raise exception using errcode = '22023', message = 'Confira quantidade, unidade e tolerâncias dos ingredientes.';
    end if;

    if material is not null then
      select base_unit into material_unit from public.items where id = material and active
        and classification in ('INSUMO','FARINHA_USO_REVENDA_A_VALIDAR') for share;
      if not found or material_unit is null or (unit_name is not null and not (
        material_unit = unit_name or (material_unit in ('kg','g') and unit_name in ('kg','g'))
        or (material_unit in ('L','mL') and unit_name in ('L','mL'))
      )) then
        raise exception using errcode = '22023', message = 'O insumo precisa estar ativo e ter unidade compatível.';
      end if;
    end if;

    insert into public.recipe_review_ingredients(recipe_version_id,source_ingredient_id,item_id,quantity,unit,stage,
      lower_tolerance,upper_tolerance,technical_reference)
    values(target_version,ingredient_id,material,qty,unit_name,stage_name,low,high,
      nullif(btrim(entry->>'technical_reference'),''))
    on conflict(recipe_version_id,source_ingredient_id) do update set
      item_id=excluded.item_id,quantity=excluded.quantity,unit=excluded.unit,stage=excluded.stage,
      lower_tolerance=excluded.lower_tolerance,upper_tolerance=excluded.upper_tolerance,
      technical_reference=excluded.technical_reference;
  end loop;

  insert into public.audit_logs(actor,action,details) values(auth.uid(),'SALVAR_REVISAO_RECEITA',
    jsonb_build_object('receita_versao_id',target_version));
  update public.operation_requests set result = target_version
    where actor = auth.uid() and operation = 'SALVAR_REVISAO_RECEITA' and operation_requests.request_id = save_recipe_review.request_id;
  return target_version;
end
$$;

create function public.save_recipe_review(target_version uuid, expected_version int, input jsonb, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.save_recipe_review(target_version,expected_version,input,request_id)
$$;
revoke all on function purezza_private.save_recipe_review(uuid,int,jsonb,uuid), public.save_recipe_review(uuid,int,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function purezza_private.save_recipe_review(uuid,int,jsonb,uuid), public.save_recipe_review(uuid,int,jsonb,uuid)
  to authenticated;
