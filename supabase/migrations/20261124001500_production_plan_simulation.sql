create function public.calculate_production_plan(
  target_demand uuid, target_recipe_version uuid, yield_mode text, simulated_stock_kg numeric
)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  demand public.production_demands%rowtype;
  recipe public.recipe_versions%rowtype;
  selected_yield numeric;
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

  selected_yield := case when yield_mode = 'CONSERVADOR' then recipe.yield_min else recipe.yield_target end;
  net_kg := greatest(0, demand.requested_kg - simulated_stock_kg);
  batches := div(net_kg, selected_yield) + case when mod(net_kg, selected_yield) > 0 then 1 else 0 end;
  min_output := batches * recipe.yield_min;
  target_output := batches * recipe.yield_target;
  max_output := batches * recipe.yield_max;

  select case when bool_and(quantity is not null and unit in ('kg','g'))
    then sum(quantity * case unit when 'kg' then 1 when 'g' then 0.001 end) end
    into flour_per_batch from public.recipe_ingredients
    where recipe_version_id = recipe.id and lower(btrim(source_name)) = 'farinha de trigo';

  select coalesce(jsonb_agg(jsonb_build_object(
    'name', source_name, 'unit', unit, 'per_batch', quantity::text,
    'planned_quantity', (quantity * batches)::text
  ) order by ordinal), '[]'::jsonb) into ingredients
  from public.recipe_ingredients where recipe_version_id = recipe.id;

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

revoke all on function public.calculate_production_plan(uuid,uuid,text,numeric) from public, anon, authenticated;
grant execute on function public.calculate_production_plan(uuid,uuid,text,numeric) to authenticated;
