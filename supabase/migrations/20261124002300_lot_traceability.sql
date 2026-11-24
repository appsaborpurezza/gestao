create index stock_reservations_lot_history_idx on public.stock_reservations(lot_id);

create function purezza_private.trace_inventory_lot(internal_code text)
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
      lot.return_shipment_id, returned.reason as return_reason, parent.internal_code as parent_code,
      case when lot.return_shipment_id is not null then 'DEVOLUCAO'
        when lot.receipt_id is not null then 'RECEBIMENTO' else 'INVENTARIO_INICIAL' end as origin
    from family
    join public.inventory_lots lot on lot.id = family.lot_id
    join public.manufacturers maker on maker.id = lot.manufacturer_id
    left join public.inventory_lots parent on parent.id = family.parent_id
    left join public.receipts receipt on receipt.id = lot.receipt_id
    left join public.suppliers supplier on supplier.id = receipt.supplier_id
    left join public.locations origin_location on origin_location.id = lot.opening_location_id
    left join public.profiles opened_profile on opened_profile.id = lot.opened_by
    left join public.shipment_returns returned on returned.return_lot_id = lot.id
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

create function public.trace_inventory_lot(internal_code text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.trace_inventory_lot(internal_code)
$$;
revoke all on function purezza_private.trace_inventory_lot(text), public.trace_inventory_lot(text) from public, anon, authenticated;
grant execute on function purezza_private.trace_inventory_lot(text), public.trace_inventory_lot(text) to authenticated;
