create table public.production_orders (
  id uuid primary key default gen_random_uuid(),
  production_number bigint generated always as identity unique,
  demand_id uuid not null unique references public.production_demands(order_item_id),
  assignment_id uuid not null references public.customer_product_recipes,
  recipe_version_id uuid not null references public.recipe_approvals(recipe_version_id),
  recipe_name text not null,
  recipe_snapshot jsonb not null,
  yield_mode text not null check (yield_mode in ('MEDIO','CONSERVADOR')),
  target_kg numeric(21,9) not null check (target_kg > 0),
  yield_kg numeric(18,6) not null check (yield_kg > 0),
  batches_count int not null check (batches_count > 0),
  status text not null default 'PLANEJADA' check (status = 'PLANEJADA'),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  planned_by uuid not null references public.profiles,
  planned_at timestamptz not null default statement_timestamp()
);
create index production_orders_recipe_idx on public.production_orders(recipe_version_id);

create table public.production_batches (
  id uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references public.production_orders,
  sequence int not null check (sequence > 0),
  status text not null default 'PLANEJADA' check (status = 'PLANEJADA'),
  unique (production_order_id,sequence)
);

do $$
declare relation text;
begin
  foreach relation in array array['production_orders','production_batches'] loop
    execute format('alter table public.%I enable row level security',relation);
    execute format('revoke all on public.%I from public, anon, authenticated',relation);
    execute format('grant select on public.%I to authenticated',relation);
    execute format('create policy production_plan_technical_read on public.%I for select to authenticated
      using ((select purezza_private.has_role(''ADMINISTRADOR'',''PRODUCAO'')))',relation);
  end loop;
end
$$;

create function purezza_private.create_production_order(
  target_demand uuid, expected_assignment uuid, yield_mode text, reason text, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  demand public.production_demands%rowtype;
  review public.recipe_reviews%rowtype;
  chosen jsonb;
  recipe_id uuid;
  estimate jsonb;
  ingredients jsonb;
  batch_count numeric;
  materials_inactive boolean;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode planejar ordens de produção.';
  end if;
  if expected_assignment is null or yield_mode is null or yield_mode not in ('MEDIO','CONSERVADOR')
    or nullif(btrim(reason),'') is null or length(btrim(reason)) > 500 then
    raise exception using errcode = '22023', message = 'Informe a associação aprovada, o cenário e a justificativa.';
  end if;
  result_id := purezza_private.claim_operation('CRIAR_ORDEM_PRODUCAO',request_id,
    jsonb_build_array(target_demand,expected_assignment,yield_mode,reason));
  if result_id is not null then return result_id; end if;

  select * into demand from public.production_demands where order_item_id = target_demand for update;
  if not found or demand.requested_kg is null then
    raise exception using errcode = '22023', message = 'A demanda precisa ter peso conhecido em kg.';
  end if;
  if exists(select from public.production_orders where demand_id = target_demand) then
    raise exception using errcode = '23505', message = 'A demanda já tem uma ordem de produção.';
  end if;
  perform id from public.items where id = demand.item_id and active for share;
  if not found then raise exception using errcode = '22023', message = 'O produto da demanda precisa estar ativo.'; end if;

  chosen := purezza_private.resolve_demand_recipe(target_demand);
  if (chosen->>'assignment_id')::uuid is distinct from expected_assignment then
    raise exception using errcode = '40001', message = 'A associação vigente mudou ou não está disponível.';
  end if;
  recipe_id := (chosen->>'recipe_version_id')::uuid;
  select * into strict review from public.recipe_reviews where recipe_version_id = recipe_id;
  estimate := public.calculate_production_plan(target_demand,recipe_id,yield_mode,0);
  batch_count := (estimate->>'batches')::numeric;
  if batch_count not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'A ordem precisa gerar de 1 a 1.000 massadas planejadas.';
  end if;

  perform material.id from public.items material
    where material.id in (select item_id from public.recipe_review_ingredients where recipe_version_id = recipe_id)
    order by material.id for share;
  select bool_or(line.item_id is not null and (
      not material.active or material.base_unit is null
      or not (material.base_unit = line.unit or (material.base_unit in ('kg','g') and line.unit in ('kg','g'))
        or (material.base_unit in ('L','mL') and line.unit in ('L','mL')))
    )), coalesce(jsonb_agg(jsonb_build_object(
      'source_ingredient_id',source.id,'name',source.source_name,'item_id',line.item_id,
      'item_code',material.original_code,'base_unit',material.base_unit,
      'quantity',line.quantity::text,'unit',line.unit,'stage',line.stage,
      'lower_tolerance',line.lower_tolerance::text,'upper_tolerance',line.upper_tolerance::text,
      'technical_reference',line.technical_reference
    ) order by source.ordinal),'[]'::jsonb)
    into materials_inactive,ingredients
    from public.recipe_review_ingredients line
    join public.recipe_ingredients source on source.id = line.source_ingredient_id
    left join public.items material on material.id = line.item_id
    where line.recipe_version_id = recipe_id;
  if materials_inactive then
    raise exception using errcode = '22023', message = 'Há um insumo da ficha aprovada inativo ou com unidade incompatível.';
  end if;

  insert into public.production_orders(demand_id,assignment_id,recipe_version_id,recipe_name,recipe_snapshot,yield_mode,
    target_kg,yield_kg,batches_count,reason,planned_by)
  values(target_demand,expected_assignment,recipe_id,chosen->>'recipe_name',
    jsonb_build_object('recipe',chosen,'ingredients',ingredients,'review_version',review.edit_version,
      'shelf_life_days',review.shelf_life_days,'storage_conditions',review.storage_conditions,
      'water_control_reference',review.water_control_reference,'review_reference',review.review_reference,
      'yield_min',review.yield_min::text,'yield_target',review.yield_target::text,'yield_max',review.yield_max::text,
      'product_id',demand.item_id,'product_code',demand.item_code,'product_unit',demand.unit,'delivery_date',demand.delivery_date),
    yield_mode,demand.requested_kg,(estimate->>'yield_kg')::numeric,batch_count::int,btrim(reason),auth.uid())
  returning id into result_id;
  insert into public.production_batches(production_order_id,sequence)
    select result_id,position from generate_series(1,batch_count::int) position;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'CRIAR_ORDEM_PRODUCAO',
    jsonb_build_object('ordem_producao_id',result_id,'demanda_id',target_demand,'massadas',batch_count));
  update public.operation_requests set result=result_id
    where actor=auth.uid() and operation='CRIAR_ORDEM_PRODUCAO'
      and operation_requests.request_id=create_production_order.request_id;
  return result_id;
end
$$;

create function public.create_production_order(
  target_demand uuid, expected_assignment uuid, yield_mode text, reason text, request_id uuid
)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.create_production_order(target_demand,expected_assignment,yield_mode,reason,request_id)
$$;
revoke all on function purezza_private.create_production_order(uuid,uuid,text,text,uuid),
  public.create_production_order(uuid,uuid,text,text,uuid) from public, anon, authenticated;
grant execute on function purezza_private.create_production_order(uuid,uuid,text,text,uuid),
  public.create_production_order(uuid,uuid,text,text,uuid) to authenticated;
