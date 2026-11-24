create function purezza_private.trace_production_genealogy(selected_lots uuid[])
returns jsonb language sql stable security invoker set search_path = '' as $$
  with selected_batches as (
    select production_batch_id as id from public.inventory_lots
    where id=any(selected_lots) and production_batch_id is not null
  ), raw_links as (
    select consumption.batch_id, position.lot_id, position.location_id, position.quantity,
      position.movement_id, consumption.stage, ingredient.source_name as material, 'INGREDIENTE'::text as kind
    from public.batch_ingredient_consumption_lots position
    join public.batch_ingredient_consumptions consumption on consumption.id=position.consumption_id
    join public.recipe_ingredients ingredient on ingredient.id=consumption.ingredient_id
    where position.lot_id=any(selected_lots) or consumption.batch_id in (select id from selected_batches)
    union all
    select usage.batch_id,usage.lot_id,usage.location_id,usage.quantity,usage.movement_id,'EMBALAGEM',
      coalesce(item.commercial_description,item.original_description),
      case when usage.item_id=config.package_item_id then 'EMBALAGEM' else 'ETIQUETA' end
    from public.batch_packaging_consumptions usage
    join public.batch_finished_outputs output on output.batch_id=usage.batch_id
    join public.product_packaging_configs config on config.id=output.packing_config_id
    join public.items item on item.id=usage.item_id
    where usage.lot_id=any(selected_lots) or usage.batch_id in (select id from selected_batches)
  ), relevant_batches as (
    select id from selected_batches
    union
    select batch_id from raw_links
  ), linked_batches as (
    select batch.id,batch.lot_code as batch_code,batch.sequence,batch.status,
      plan.production_number::text as production_number,plan.recipe_name,version.version as recipe_version,
      demand.item_code,demand.description as product,
      output_lot.internal_code as output_code,output_lot.status as output_status,
      output.unit_count::text as output_units,output.nominal_kg::text as nominal_kg,
      output.actual_kg::text as actual_kg,output.finished_at,actor.display_name as finished_by
    from relevant_batches batch_ids
    join public.production_batches batch on batch.id=batch_ids.id
    join public.production_orders plan on plan.id=batch.production_order_id
    join public.recipe_versions version on version.id=plan.recipe_version_id
    join public.production_demands demand on demand.order_item_id=plan.demand_id
    left join public.batch_finished_outputs output on output.batch_id=batch.id
    left join public.inventory_lots output_lot on output_lot.id=output.output_lot_id
    left join public.profiles actor on actor.id=output.finished_by
  ), links as (
    select raw.batch_id,raw.lot_id,raw.movement_id,raw.stage,raw.material,raw.kind,raw.quantity::text as quantity,
      lot.internal_code as source_code,lot.original_lot as source_original_lot,lot.expires_on,lot.unit,
      location.code as location,maker.name as manufacturer,supplier.name as supplier,
      receipt.invoice_number,lot.opening_reference,lot.opening_invoice,
      movement.created_at as consumed_at,actor.display_name as operator
    from raw_links raw
    join public.stock_movements movement on movement.id=raw.movement_id
    join public.profiles actor on actor.id=movement.actor
    join public.inventory_lots lot on lot.id=raw.lot_id
    join public.locations location on location.id=raw.location_id
    join public.manufacturers maker on maker.id=lot.manufacturer_id
    left join public.receipts receipt on receipt.id=lot.receipt_id
    left join public.suppliers supplier on supplier.id=receipt.supplier_id
  ), water as (
    select record.id,record.batch_id,record.stage,record.source,record.control_reference,record.quantity::text as quantity,
      record.unit,record.recorded_at,actor.display_name as operator
    from relevant_batches batch_ids
    join public.batch_water_records record on record.batch_id=batch_ids.id
    join public.profiles actor on actor.id=record.recorded_by
  ), downstream as (
    select dispatch.id,batch.id as batch_id,lot.internal_code as output_code,
      purchase.order_number::text as order_number,purchase.customer_name,dispatch.quantity::text as quantity,
      lot.unit,dispatch.dispatched_at,dispatch.delivered_at,actor.display_name as operator
    from relevant_batches batch_ids
    join public.production_batches batch on batch.id=batch_ids.id
    join public.batch_finished_outputs output on output.batch_id=batch.id
    join public.inventory_lots lot on lot.id=output.output_lot_id
    join public.stock_reservations res on res.lot_id=lot.id
    join public.shipments dispatch on dispatch.reservation_id=res.id
    join public.orders purchase on purchase.id=dispatch.order_id
    join public.profiles actor on actor.id=dispatch.dispatched_by
  )
  select jsonb_build_object(
    'batches',coalesce((select jsonb_agg(to_jsonb(linked_batches) order by production_number::bigint,sequence) from linked_batches),'[]'::jsonb),
    'inputs',coalesce((select jsonb_agg(to_jsonb(links) - 'lot_id' order by consumed_at,movement_id)
      from links where batch_id in (select id from selected_batches)),'[]'::jsonb),
    'uses',coalesce((select jsonb_agg(to_jsonb(links) - 'lot_id' order by consumed_at,movement_id)
      from links where lot_id=any(selected_lots)),'[]'::jsonb),
    'water',coalesce((select jsonb_agg(to_jsonb(water) order by recorded_at,id) from water),'[]'::jsonb),
    'destinations',coalesce((select jsonb_agg(to_jsonb(downstream) order by dispatched_at,id) from downstream),'[]'::jsonb)
  )
$$;
revoke all on function purezza_private.trace_production_genealogy(uuid[]) from public,anon,authenticated;

create or replace function purezza_private.trace_inventory_lot(internal_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  target uuid;
  report jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode consultar a rastreabilidade operacional.';
  end if;
  if internal_code is null or internal_code !~ '^REC-[a-f0-9]{32}$' then
    raise exception using errcode = '22023', message = 'Informe um código interno de lote válido.';
  end if;

  select id into target from public.inventory_lots lot where lot.internal_code = trace_inventory_lot.internal_code;
  if target is null then return null; end if;

  with recursive lineage as (
    select target as lot_id, 0 as depth, array[target] as path
    union all
    select reservation.lot_id, lineage.depth + 1, lineage.path || reservation.lot_id
    from lineage
    join public.inventory_lots child on child.id = lineage.lot_id
    join public.shipments dispatch on dispatch.id = child.return_shipment_id
    join public.stock_reservations reservation on reservation.id = dispatch.reservation_id
    where reservation.lot_id <> all(lineage.path)
  ), root as (
    select lot_id from lineage order by depth desc limit 1
  ), family as (
    select root.lot_id, null::uuid as parent_id, array[root.lot_id] as path from root
    union all
    select returned.return_lot_id, family.lot_id, family.path || returned.return_lot_id
    from family
    join public.stock_reservations reservation on reservation.lot_id = family.lot_id
    join public.shipments dispatch on dispatch.reservation_id = reservation.id
    join public.shipment_returns returned on returned.shipment_id = dispatch.id
    where returned.return_lot_id <> all(family.path)
  ), lots as (
    select lot.id, lot.internal_code as code, lot.original_lot, lot.status, lot.unit, lot.expiry,
      lot.manufactured_on, lot.expires_on,
      maker.name as manufacturer, supplier.name as supplier, receipt.invoice_number,
      receipt.documentation_reason, receipt.received_at, lot.opening_reference, lot.opening_invoice, lot.opened_at,
      origin_location.code as opening_location, opened_profile.display_name as opened_by,
      lot.return_shipment_id, produced.lot_code as production_code, plan.production_number::text as production_number,
      returned.reason as return_reason, parent.internal_code as parent_code,
      case when lot.return_shipment_id is not null then 'DEVOLUCAO'
        when lot.receipt_id is not null then 'RECEBIMENTO'
        when lot.production_batch_id is not null then 'PRODUCAO' else 'INVENTARIO_INICIAL' end as origin
    from family
    join public.inventory_lots lot on lot.id = family.lot_id
    join public.manufacturers maker on maker.id = lot.manufacturer_id
    left join public.inventory_lots parent on parent.id = family.parent_id
    left join public.receipts receipt on receipt.id = lot.receipt_id
    left join public.suppliers supplier on supplier.id = receipt.supplier_id
    left join public.locations origin_location on origin_location.id = lot.opening_location_id
    left join public.profiles opened_profile on opened_profile.id = lot.opened_by
    left join public.shipment_returns returned on returned.return_lot_id = lot.id
    left join public.production_batches produced on produced.id=lot.production_batch_id
    left join public.production_orders plan on plan.id=produced.production_order_id
  ), balances as (
    select lot.code, lot.unit, location.code as location, balance.quantity::text as physical,
      coalesce((
        select sum(res.quantity-res.dispatched_quantity) from public.stock_reservations res
        where res.lot_id = lot.id and res.location_id = balance.location_id and res.released_at is null
      ),0)::text as reserved
    from lots lot join public.stock_balances balance on balance.lot_id = lot.id
    join public.locations location on location.id = balance.location_id
  ), movements as (
    select movement.id, lot.code, lot.unit, location.code as location, movement.kind, movement.quantity_delta::text as delta,
      movement.created_at, actor.display_name as operator, movement.correlation_id
    from lots lot join public.stock_movements movement on movement.lot_id = lot.id
    join public.locations location on location.id = movement.location_id
    join public.profiles actor on actor.id = movement.actor
  ), decisions as (
    select decision.id,lot.code,decision.old_status,decision.new_status,decision.reason,decision.created_at,
      actor.display_name as operator
    from lots lot join public.lot_releases decision on decision.lot_id = lot.id
    join public.profiles actor on actor.id = decision.actor
  ), destinations as (
    select dispatch.id,lot.code,lot.unit,location.code as location,purchase.order_number::text as order_number,
      purchase.customer_name,dispatch.method,dispatch.quantity::text as quantity,dispatch.dispatched_at,
      dispatch.delivered_at,actor.display_name as operator
    from lots lot
    join public.stock_reservations reservation on reservation.lot_id = lot.id
    join public.shipments dispatch on dispatch.reservation_id = reservation.id
    join public.orders purchase on purchase.id = dispatch.order_id
    join public.locations location on location.id = reservation.location_id
    join public.profiles actor on actor.id = dispatch.dispatched_by
  )
  select jsonb_build_object(
    'selected_code',trace_inventory_lot.internal_code,
    'production',purezza_private.trace_production_genealogy(array(select lot_id from family)),
    'root_code',(select code from lots join root on root.lot_id = lots.id),
    'item',(select jsonb_build_object('code',product.original_code,
      'description',coalesce(product.commercial_description,product.original_description))
      from public.inventory_lots lot join public.items product on product.id = lot.item_id where lot.id = target),
    'lots',coalesce((select jsonb_agg(to_jsonb(lots) - 'id' order by code) from lots),'[]'::jsonb),
    'balances',coalesce((select jsonb_agg(to_jsonb(balances) order by code,location) from balances),'[]'::jsonb),
    'movements',coalesce((select jsonb_agg(to_jsonb(movements) order by created_at,id) from movements),'[]'::jsonb),
    'decisions',coalesce((select jsonb_agg(to_jsonb(decisions) order by created_at,id) from decisions),'[]'::jsonb),
    'destinations',coalesce((select jsonb_agg(to_jsonb(destinations) order by dispatched_at,id) from destinations),'[]'::jsonb)
  ) into report;
  return report;
end
$$;
