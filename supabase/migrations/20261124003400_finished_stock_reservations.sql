alter table public.stock_reservations add column recipe_version_id uuid references public.recipe_versions;
alter table public.stock_reservations add column packaging_config_id uuid references public.product_packaging_configs;
alter table public.stock_reservations add constraint stock_reservation_finished_compatibility_check
  check (num_nonnulls(recipe_version_id,packaging_config_id) in (0,2));

create function purezza_private.finished_lot_matches_order(target_lot uuid,target_line uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists(
    select from public.inventory_lots lot
    join public.batch_finished_outputs output on output.output_lot_id=lot.id
    join public.production_batches batch on batch.id=output.batch_id
    join public.production_orders source_plan on source_plan.id=batch.production_order_id
    join public.customer_product_recipes source_rule on source_rule.id=source_plan.assignment_id
    join public.order_items entry on entry.id=target_line and entry.item_id=lot.item_id and entry.unit=lot.unit
    join public.orders purchase on purchase.id=entry.order_id
    left join public.production_orders target_plan on target_plan.demand_id=entry.id
    where lot.id=target_lot and batch.status='FINALIZADA'
      and (source_rule.scope='PADRAO' or source_rule.customer_id=purchase.customer_id)
      and source_plan.recipe_version_id=coalesce(target_plan.recipe_version_id,
        (purezza_private.resolve_demand_recipe(target_line)->>'recipe_version_id')::uuid)
      and output.nominal_kg=output.unit_count*entry.kg_per_unit
      and output.packing_config_id=coalesce(target_plan.packaging_config_id,(
        select config.id from public.product_packaging_configs config
        where config.product_id=entry.item_id order by config.version desc limit 1
      ))
  )
$$;
revoke all on function purezza_private.finished_lot_matches_order(uuid,uuid) from public,anon,authenticated;

create function purezza_private.demand_stock_coverage(target_demand uuid)
returns numeric language plpgsql stable security definer set search_path = '' as $$
declare covered numeric;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode='42501',message='Seu perfil não pode consultar a cobertura da demanda.';
  end if;
  select coalesce(sum(entry.kg_per_unit*(res.dispatched_quantity + case
    when res.released_at is null and res.quantity>res.dispatched_quantity and lot.status='LIBERADO'
      and location.active and (
        lot.expiry='NAO_APLICAVEL' or (lot.expiry='INFORMADA' and lot.expires_on>
          greatest(purchase.delivery_date,(statement_timestamp() at time zone 'America/Sao_Paulo')::date))
      ) and purezza_private.finished_lot_matches_order(lot.id,target_demand)
    then res.quantity-res.dispatched_quantity else 0 end)),0) into covered
  from public.order_items entry
  join public.orders purchase on purchase.id=entry.order_id
  join public.stock_reservations res on res.order_item_id=entry.id
  join public.inventory_lots lot on lot.id=res.lot_id
  join public.locations location on location.id=res.location_id
  where entry.id=target_demand and entry.confirmed_classification='FABRICACAO_PROPRIA';
  return covered;
end
$$;
create function public.demand_stock_coverage(target_demand uuid)
returns text language sql stable security invoker set search_path = '' as $$
  select purezza_private.demand_stock_coverage(target_demand)::text
$$;
revoke all on function purezza_private.demand_stock_coverage(uuid),public.demand_stock_coverage(uuid) from public,anon,authenticated;
grant execute on function purezza_private.demand_stock_coverage(uuid),public.demand_stock_coverage(uuid) to authenticated;

create or replace function purezza_private.reserve_order_stock(target_line uuid, amount numeric, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  purchase public.orders%rowtype;
  line public.order_items%rowtype;
  slot record;
  rest numeric := amount;
  allocation numeric;
  first_reservation uuid;
  reservation_id uuid;
  eligible_lots uuid[];
  own_product boolean;
  chosen_recipe uuid;
  cutoff date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'A reserva exige perfil administrador.';
  end if;
  previous := purezza_private.claim_operation('RESERVAR_ESTOQUE_PEDIDO',request_id,
    jsonb_build_array(target_line,amount));
  if previous is not null then return previous; end if;

  select * into purchase from public.orders where id = (
    select order_id from public.order_items where id = target_line
  ) for update;
  if not found or purchase.fulfillment_status not in ('CONFIRMADO','PARCIAL') then
    raise exception using errcode = '22023', message = 'Selecione um item de pedido confirmado.';
  end if;
  select * into strict line from public.order_items where id = target_line and order_id = purchase.id;
  if line.confirmed_classification is null then
    raise exception using errcode='22023',message='A linha precisa ter classificação confirmada.';
  end if;
  own_product := line.confirmed_classification='FABRICACAO_PROPRIA';
  if amount is null or not (amount > 0 and amount <= line.quantity)
    or amount <> round(amount,6) or (line.unit = 'un' and amount <> trunc(amount))
    or amount > line.quantity - (select coalesce(sum(case when released_at is null then quantity else dispatched_quantity end),0) from public.stock_reservations
      where order_item_id = target_line) then
    raise exception using errcode = '22023', message = 'Confira a quantidade ainda não reservada neste item.';
  end if;
  perform id from public.items where id = line.item_id and active for share;
  if not found then raise exception using errcode = '22023', message = 'O produto precisa estar ativo.'; end if;

  if own_product then
    chosen_recipe := coalesce((select recipe_version_id from public.production_orders where demand_id=target_line),
      (purezza_private.resolve_demand_recipe(target_line)->>'recipe_version_id')::uuid);
    if chosen_recipe is null or line.kg_per_unit is null then
      raise exception using errcode='22023',message='A linha precisa ter conversão e receita aprovada associada.';
    end if;
  end if;
  cutoff := greatest(cutoff,purchase.delivery_date);

  -- Lock lot rows first, in a common order, then calculate quantities from committed reservations.
  select array(select id from public.inventory_lots where item_id = line.item_id and unit = line.unit
    and status = 'LIBERADO' and (expiry = 'NAO_APLICAVEL' or (expiry = 'INFORMADA' and expires_on > cutoff))
    and (not own_product or purezza_private.finished_lot_matches_order(id,target_line))
    order by id for update) into eligible_lots;
  for slot in
    select lot.id lot_id, balance.location_id, output.packing_config_id, balance.quantity - coalesce((
      select sum(quantity-dispatched_quantity) from public.stock_reservations where lot_id = lot.id
        and location_id = balance.location_id and released_at is null
    ),0) as available
    from public.inventory_lots lot
    join public.stock_balances balance on balance.lot_id = lot.id
    join public.locations location on location.id = balance.location_id and location.active
    left join public.receipts receipt on receipt.id = lot.receipt_id
    left join public.batch_finished_outputs output on output.output_lot_id=lot.id
    where lot.id = any(eligible_lots) and lot.status = 'LIBERADO'
      and (lot.expiry = 'NAO_APLICAVEL' or (lot.expiry = 'INFORMADA' and lot.expires_on > cutoff))
      and balance.quantity > 0
    order by lot.expires_on nulls last, coalesce(receipt.received_at,lot.opened_at,output.finished_at),lot.id,balance.location_id
    for share of location
  loop
    if slot.available <= 0 then continue; end if;
    allocation := least(rest,slot.available);
    insert into public.stock_reservations(order_item_id,lot_id,location_id,quantity,reserved_by,recipe_version_id,packaging_config_id)
      values(target_line,slot.lot_id,slot.location_id,allocation,auth.uid(),chosen_recipe,
        case when own_product then slot.packing_config_id end) returning id into reservation_id;
    first_reservation := coalesce(first_reservation,reservation_id);
    rest := rest - allocation;
    exit when rest = 0;
  end loop;
  if rest <> 0 then
    raise exception using errcode = '22023', message = 'Saldo elegível insuficiente para reservar essa quantidade.';
  end if;

  insert into public.audit_logs(actor,action,details) values(auth.uid(),'RESERVAR_ESTOQUE_PEDIDO',
    jsonb_build_object('item_pedido_id',target_line,'quantidade',amount,'primeira_reserva_id',first_reservation));
  update public.operation_requests set result = first_reservation
    where actor = auth.uid() and operation = 'RESERVAR_ESTOQUE_PEDIDO'
      and operation_requests.request_id = reserve_order_stock.request_id;
  return first_reservation;
end
$$;

create or replace function purezza_private.confirm_shipment(target_reservation uuid, amount numeric, method text, notes text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  shipment_id uuid := gen_random_uuid();
  movement_id uuid;
  purchase public.orders%rowtype;
  reservation public.stock_reservations%rowtype;
  lot public.inventory_lots%rowtype;
  ordered_unit text;
  ordered_item uuid;
  ordered_classification text;
  cutoff date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
  order_complete boolean;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode confirmar expedições.';
  end if;
  previous := purezza_private.claim_operation('EXPEDIR_RESERVA',request_id,
    jsonb_build_array(target_reservation,amount,method,notes));
  if previous is not null then return previous; end if;

  select * into purchase from public.orders where id = (
    select entry.order_id from public.stock_reservations res
    join public.order_items entry on entry.id = res.order_item_id where res.id = target_reservation
  ) for update;
  if not found or purchase.fulfillment_status not in ('CONFIRMADO','PARCIAL') then
    raise exception using errcode = '22023', message = 'Selecione uma reserva de pedido em atendimento.';
  end if;
  select entry.unit,entry.item_id,entry.confirmed_classification into strict ordered_unit,ordered_item,ordered_classification
    from public.order_items entry join public.stock_reservations res on res.order_item_id=entry.id
    where res.id=target_reservation;
  if ordered_classification='FABRICACAO_PROPRIA' then
    perform id from public.items where id=ordered_item and active for share;
    if not found then raise exception using errcode='22023',message='O produto da reserva ficou inativo.'; end if;
  end if;
  select * into strict lot from public.inventory_lots where id = (
    select lot_id from public.stock_reservations where id = target_reservation
  ) for update;
  select * into strict reservation from public.stock_reservations where id = target_reservation for update;

  cutoff := greatest(cutoff,purchase.delivery_date);
  if reservation.released_at is not null or amount is null
    or not (amount > 0 and amount <= reservation.quantity - reservation.dispatched_quantity)
    or amount <> round(amount,6) or (ordered_unit = 'un' and amount <> trunc(amount))
    or method is null or method not in ('ENTREGA','RETIRADA') then
    raise exception using errcode = '22023', message = 'Confira a modalidade e a quantidade ainda reservada.';
  end if;
  if lot.status <> 'LIBERADO' or lot.unit <> ordered_unit or not (
    lot.expiry = 'NAO_APLICAVEL' or (lot.expiry = 'INFORMADA' and lot.expires_on > cutoff)
  ) then
    raise exception using errcode = '22023', message = 'O lote não está elegível para expedição.';
  end if;
  if ordered_classification='FABRICACAO_PROPRIA' and (
    reservation.recipe_version_id is null or not purezza_private.finished_lot_matches_order(lot.id,reservation.order_item_id)
  ) then
    raise exception using errcode='22023',message='O lote acabado deixou de ser compatível com o pedido.';
  end if;
  perform id from public.locations where id = reservation.location_id and active for share;
  if not found then raise exception using errcode = '22023', message = 'O local da reserva está inativo.'; end if;

  update public.stock_reservations set dispatched_quantity = dispatched_quantity + amount
    where id = target_reservation;
  update public.stock_balances set quantity = quantity - amount
    where lot_id = reservation.lot_id and location_id = reservation.location_id and quantity >= amount;
  if not found then raise exception using errcode = '22023', message = 'Saldo físico insuficiente para expedição.'; end if;

  insert into public.stock_movements(lot_id,location_id,quantity_delta,kind,actor,correlation_id)
    values(reservation.lot_id,reservation.location_id,-amount,'EXPEDICAO',auth.uid(),shipment_id)
    returning id into movement_id;
  insert into public.shipments(id,order_id,reservation_id,stock_movement_id,quantity,method,notes,dispatched_by)
    values(shipment_id,purchase.id,target_reservation,movement_id,amount,method,nullif(btrim(notes),''),auth.uid());

  select not exists(
    select from public.order_items entry where entry.order_id = purchase.id
      and entry.quantity > (select coalesce(sum(res.dispatched_quantity),0) from public.stock_reservations res
        where res.order_item_id = entry.id)
  ) into order_complete;
  update public.orders set fulfillment_status = case when order_complete then 'EXPEDIDO' else 'PARCIAL' end,
    version = version + 1 where id = purchase.id;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'EXPEDIR_RESERVA',
    jsonb_build_object('pedido_id',purchase.id,'expedicao_id',shipment_id));
  update public.operation_requests set result = shipment_id
    where actor = auth.uid() and operation = 'EXPEDIR_RESERVA' and operation_requests.request_id = confirm_shipment.request_id;
  return shipment_id;
end
$$;

create or replace function purezza_private.create_production_order(
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
  covered numeric;
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

  perform id from public.orders where id=(select order_id from public.production_demands where order_item_id=target_demand)
    and fulfillment_status in ('CONFIRMADO','PARCIAL') for update;
  if not found then raise exception using errcode='22023',message='A demanda precisa pertencer a um pedido em atendimento.'; end if;
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
  perform id from public.inventory_lots where id in (
    select lot_id from public.stock_reservations where order_item_id=target_demand and released_at is null
  ) order by id for share;
  covered := purezza_private.demand_stock_coverage(target_demand);
  if covered>=demand.requested_kg then
    raise exception using errcode='22023',message='A demanda já está integralmente coberta por estoque reservado ou despachado.';
  end if;
  estimate := public.calculate_production_plan(target_demand,recipe_id,yield_mode,covered);
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
      'ordered_kg',demand.requested_kg::text,'stock_covered_kg',covered::text,
      'product_id',demand.item_id,'product_code',demand.item_code,'product_unit',demand.unit,'delivery_date',demand.delivery_date),
    yield_mode,(estimate->>'net_kg')::numeric,(estimate->>'yield_kg')::numeric,batch_count::int,btrim(reason),auth.uid())
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

create or replace function purezza_private.shipping_queue(page_size int, page_offset int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare report jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode acessar a fila de expedição.';
  end if;
  if page_size is null or page_size not between 1 and 100 or page_offset is null or page_offset < 0 then
    raise exception using errcode = '22023', message = 'Confira a paginação.';
  end if;
  with queue as (
    select res.id, purchase.order_number, purchase.customer_name, purchase.delivery_date, entry.description,
      entry.unit, lot.internal_code, location.code as location_code,
      (res.quantity - res.dispatched_quantity)::text as remaining,
      (lot.status = 'LIBERADO' and location.active and (
        lot.expiry = 'NAO_APLICAVEL' or (lot.expiry = 'INFORMADA' and lot.expires_on >
          greatest(purchase.delivery_date,(statement_timestamp() at time zone 'America/Sao_Paulo')::date))
      ) and (entry.confirmed_classification<>'FABRICACAO_PROPRIA'
        or purezza_private.finished_lot_matches_order(lot.id,entry.id))) as eligible
    from public.stock_reservations res
    join public.order_items entry on entry.id = res.order_item_id
    join public.orders purchase on purchase.id = entry.order_id
    join public.inventory_lots lot on lot.id = res.lot_id
    join public.locations location on location.id = res.location_id
    where res.released_at is null and res.dispatched_quantity < res.quantity
      and purchase.fulfillment_status in ('CONFIRMADO','PARCIAL')
  ), page as (
    select * from queue order by delivery_date,order_number,id limit page_size offset page_offset
  )
  select jsonb_build_object('total',(select count(*) from queue),
    'rows',coalesce((select jsonb_agg(to_jsonb(page) order by delivery_date,order_number,id) from page),'[]'::jsonb)) into report;
  return report;
end
$$;
