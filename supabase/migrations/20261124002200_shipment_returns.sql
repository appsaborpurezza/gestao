alter table public.inventory_lots add column return_shipment_id uuid references public.shipments;
create index inventory_lots_return_shipment_idx on public.inventory_lots(return_shipment_id) where return_shipment_id is not null;
alter table public.inventory_lots drop constraint inventory_lot_origin_check;
alter table public.inventory_lots add constraint inventory_lot_origin_check check (
  (num_nonnulls(receipt_id, opening_location_id, return_shipment_id) = 1)
  and ((opening_location_id is null and opening_reference is null and opening_invoice is null
      and opened_at is null and opened_by is null)
    or (opening_location_id is not null and nullif(btrim(opening_reference), '') is not null
      and opened_at is not null and opened_by is not null))
);
drop index public.opening_lot_identity_idx;
create unique index opening_lot_identity_idx
  on public.inventory_lots(item_id, manufacturer_id, original_lot) where opening_location_id is not null;

alter table public.stock_movements drop constraint stock_movements_kind_check;
alter table public.stock_movements add constraint stock_movements_kind_check
  check (kind in ('RECEBIMENTO','TRANSFERENCIA','AJUSTE_INVENTARIO','ABERTURA_INVENTARIO','EXPEDICAO','DEVOLUCAO_EXPEDICAO'));

create table public.shipment_returns (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments,
  return_lot_id uuid not null unique references public.inventory_lots,
  stock_movement_id uuid not null unique references public.stock_movements,
  quantity numeric(18,6) not null check (quantity > 0 and quantity <> 'NaN'::numeric),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  registered_by uuid not null references public.profiles,
  registered_at timestamptz not null default statement_timestamp()
);
create index shipment_returns_shipment_idx on public.shipment_returns(shipment_id,registered_at);
alter table public.shipment_returns enable row level security;
revoke all on public.shipment_returns from public, anon, authenticated;
grant select on public.shipment_returns to authenticated;
create policy shipment_returns_operational_read on public.shipment_returns for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR','PRODUCAO')));

create or replace function purezza_private.guard_opening_lot_release()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.return_shipment_id is not null and new.status = 'LIBERADO' then
    raise exception using errcode = '22023', message = 'O lote devolvido exige avaliação em fluxo de devoluções antes de liberar.';
  end if;
  if new.opening_location_id is not null and new.status = 'LIBERADO'
    and (nullif(btrim(new.opening_invoice), '') is null
      or not exists (
        select from public.stock_movements where lot_id = new.id and kind = 'ABERTURA_INVENTARIO'
      )) then
    raise exception using errcode = '22023', message = 'Liberação exige contagem inicial aprovada e documento de origem.';
  end if;
  return new;
end
$$;

create function purezza_private.register_shipment_return(
  target_shipment uuid, target_location uuid, amount numeric, reason text, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  return_id uuid := gen_random_uuid();
  previous uuid;
  dispatch public.shipments%rowtype;
  source_lot public.inventory_lots%rowtype;
  new_lot uuid;
  movement uuid;
  returned numeric;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode registrar devoluções.';
  end if;
  previous := purezza_private.claim_operation('REGISTRAR_DEVOLUCAO',request_id,
    jsonb_build_array(target_shipment,target_location,amount,reason));
  if previous is not null then return previous; end if;

  select * into dispatch from public.shipments where id = target_shipment for update;
  if not found then raise exception using errcode = '22023', message = 'Selecione a expedição original.'; end if;
  select * into strict source_lot from public.inventory_lots where id = (
    select lot_id from public.stock_reservations where id = dispatch.reservation_id
  );
  select coalesce(sum(quantity),0) into returned from public.shipment_returns where shipment_id = target_shipment;
  if amount is null or not (amount > 0 and amount <= dispatch.quantity - returned)
    or amount <> round(amount,6) or (source_lot.unit = 'un' and amount <> trunc(amount))
    or nullif(btrim(reason),'') is null or length(btrim(reason)) > 500 then
    raise exception using errcode = '22023', message = 'Confira a quantidade ainda devolvível e o motivo.';
  end if;
  perform id from public.locations where id = target_location and active for share;
  if not found then raise exception using errcode = '22023', message = 'Selecione um local ativo para a quarentena.'; end if;

  insert into public.inventory_lots(item_id,manufacturer_id,original_lot,manufactured_on,expires_on,
    expiry,expiry_reason,unit,return_shipment_id)
  values(source_lot.item_id,source_lot.manufacturer_id,source_lot.original_lot,source_lot.manufactured_on,
    source_lot.expires_on,source_lot.expiry,source_lot.expiry_reason,source_lot.unit,target_shipment)
  returning id into new_lot;
  insert into public.stock_balances(lot_id,location_id,quantity) values(new_lot,target_location,amount);
  insert into public.stock_movements(lot_id,location_id,quantity_delta,kind,actor,correlation_id)
    values(new_lot,target_location,amount,'DEVOLUCAO_EXPEDICAO',auth.uid(),return_id)
    returning id into movement;
  insert into public.shipment_returns(id,shipment_id,return_lot_id,stock_movement_id,quantity,reason,registered_by)
    values(return_id,target_shipment,new_lot,movement,amount,btrim(reason),auth.uid());

  insert into public.audit_logs(actor,action,details) values(auth.uid(),'REGISTRAR_DEVOLUCAO',
    jsonb_build_object('expedicao_id',target_shipment,'devolucao_id',return_id,'lote_id',new_lot));
  update public.operation_requests set result = return_id
    where actor = auth.uid() and operation = 'REGISTRAR_DEVOLUCAO'
      and operation_requests.request_id = register_shipment_return.request_id;
  return return_id;
end
$$;

create function public.register_shipment_return(
  target_shipment uuid, target_location uuid, amount numeric, reason text, request_id uuid
)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.register_shipment_return(target_shipment,target_location,amount,reason,request_id)
$$;
revoke all on function purezza_private.register_shipment_return(uuid,uuid,numeric,text,uuid),
  public.register_shipment_return(uuid,uuid,numeric,text,uuid) from public, anon, authenticated;
grant execute on function purezza_private.register_shipment_return(uuid,uuid,numeric,text,uuid),
  public.register_shipment_return(uuid,uuid,numeric,text,uuid) to authenticated;

create or replace function purezza_private.open_inventory_lot(input jsonb, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  lot uuid;
  item uuid;
  maker uuid;
  location uuid;
  amount numeric;
  lot_unit text;
  manufacture date;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'A abertura exige perfil administrador.';
  end if;
  lot := purezza_private.claim_operation('ABERTURA_LOTE', request_id, input);
  if lot is not null then return lot; end if;

  item := (input->>'item_id')::uuid;
  maker := (input->>'manufacturer_id')::uuid;
  location := (input->>'location_id')::uuid;
  amount := (input->>'quantity')::numeric;
  manufacture := (input->>'manufactured_on')::date;
  select base_unit into lot_unit from public.items where id = item and active for share;
  if lot_unit is null or input->>'unit' is distinct from lot_unit
    or amount is null or not (amount > 0 and amount < 1000000000000)
    or amount <> round(amount, 6) or (lot_unit = 'un' and amount <> trunc(amount))
    or manufacture > (statement_timestamp() at time zone 'America/Sao_Paulo')::date then
    raise exception using errcode = '22023', message = 'Confira unidade base, quantidade e data de fabricação.';
  end if;
  perform id from public.manufacturers where id = maker and active for share;
  if not found then raise exception using errcode = '22023', message = 'Fabricante inativo ou inexistente.'; end if;
  perform id from public.locations where id = location and active for share;
  if not found then raise exception using errcode = '22023', message = 'Local inativo ou inexistente.'; end if;

  insert into public.inventory_lots(item_id, manufacturer_id, original_lot, manufactured_on,
    expires_on, expiry, expiry_reason, unit, opening_location_id, opening_reference, opening_invoice, opened_at, opened_by)
  values(item, maker, btrim(input->>'original_lot'), manufacture,
    (input->>'expires_on')::date, (input->>'expiry')::public.expiry_basis, input->>'expiry_reason',
    lot_unit, location, input->>'opening_reference', nullif(btrim(input->>'opening_invoice'), ''),
    statement_timestamp(), auth.uid())
  on conflict (item_id, manufacturer_id, original_lot) where opening_location_id is not null do nothing returning id into lot;
  if lot is null then
    raise exception using errcode = '23505', message = 'Já existe abertura para este item, fabricante e lote de origem.';
  end if;

  insert into public.inventory_counts(lot_id, location_id, expected_quantity, counted_quantity, movement_count, reason, counter_id)
    values(lot, location, 0, amount, 0, input->>'opening_reference', auth.uid());
  update public.operation_requests set result = lot
    where actor = auth.uid() and operation = 'ABERTURA_LOTE' and operation_requests.request_id = open_inventory_lot.request_id;
  return lot;
end
$$;

create or replace function purezza_private.request_inventory_label(target_lot uuid, request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  request_record uuid;
  snapshot jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode emitir etiquetas de estoque.';
  end if;

  request_record := purezza_private.claim_operation('ETIQUETA_LOTE', request_id, jsonb_build_array(target_lot));
  if request_record is not null then
    select label_snapshot into strict snapshot from public.inventory_label_requests where id = request_record;
    return snapshot;
  end if;

  perform id from public.inventory_lots where id = target_lot for share;
  select jsonb_build_object(
    'internal_code', lot.internal_code,
    'original_lot', lot.original_lot,
    'description', coalesce(item.commercial_description, item.original_description),
    'manufacturer', maker.name,
    'manufactured_on', lot.manufactured_on,
    'expires_on', lot.expires_on,
    'expiry', lot.expiry,
    'initial_quantity', first_movement.quantity_delta::text,
    'unit', lot.unit,
    'initial_location', initial_location.code,
    'document', coalesce(receipt.invoice_number, lot.opening_invoice, original_order.order_number::text),
    'document_type', case when original_order.id is not null then 'Pedido de origem'
      when receipt.id is null then 'Documento de origem' else 'NF' end
  ) into snapshot
  from public.inventory_lots lot
  join public.items item on item.id = lot.item_id
  join public.manufacturers maker on maker.id = lot.manufacturer_id
  left join public.receipts receipt on receipt.id = lot.receipt_id
  left join public.shipments dispatch on dispatch.id = lot.return_shipment_id
  left join public.orders original_order on original_order.id = dispatch.order_id
  join public.stock_movements first_movement on first_movement.lot_id = lot.id
    and first_movement.kind in ('RECEBIMENTO', 'ABERTURA_INVENTARIO', 'DEVOLUCAO_EXPEDICAO')
  join public.locations initial_location on initial_location.id = first_movement.location_id
  where lot.id = target_lot;
  if snapshot is null then
    raise exception using errcode = '22023', message = 'A etiqueta exige um lote com entrada inicial registrada.';
  end if;

  insert into public.inventory_label_requests(lot_id, actor, label_snapshot)
    values(target_lot, auth.uid(), snapshot) returning id into request_record;
  update public.operation_requests set result = request_record
    where actor = auth.uid() and operation = 'ETIQUETA_LOTE'
      and operation_requests.request_id = request_inventory_label.request_id;
  return snapshot;
end
$$;

create or replace function purezza_private.shipment_history(pending_only boolean, page_size int, page_offset int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare report jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO','VENDAS') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode consultar o histórico de expedição.';
  end if;
  if pending_only is null or page_size is null or page_size not between 1 and 100 or page_offset is null or page_offset < 0 then
    raise exception using errcode = '22023', message = 'Confira o filtro e a paginação.';
  end if;
  with eligible as (
    select id,order_id,reservation_id,quantity,method,notes,dispatched_at,delivered_at,delivery_reference
    from public.shipments where not pending_only or delivered_at is null
  ), paged as (
    select * from eligible order by dispatched_at desc,id limit page_size offset page_offset
  ), details as (
    select dispatch.id,purchase.order_number,purchase.customer_name,purchase.delivery_date,
      entry.description,entry.unit,lot.internal_code,location.code as location_code,
      dispatch.quantity::text as quantity,dispatch.method,dispatch.notes,dispatch.dispatched_at,
      dispatch.delivered_at,dispatch.delivery_reference,
      (dispatch.quantity - coalesce(returned.quantity,0))::text as returnable,
      coalesce(returned.lots,'[]'::jsonb) as returned_lots
    from paged dispatch
    join public.orders purchase on purchase.id = dispatch.order_id
    join public.stock_reservations res on res.id = dispatch.reservation_id
    join public.order_items entry on entry.id = res.order_item_id
    join public.inventory_lots lot on lot.id = res.lot_id
    join public.locations location on location.id = res.location_id
    left join lateral (
      select sum(entry.quantity) quantity, jsonb_agg(jsonb_build_object('code',returned_lot.internal_code,
        'quantity',entry.quantity::text) order by entry.registered_at,entry.id) lots
      from public.shipment_returns entry join public.inventory_lots returned_lot on returned_lot.id = entry.return_lot_id
      where entry.shipment_id = dispatch.id
    ) returned on true
  )
  select jsonb_build_object('total',(select count(*) from eligible),
    'rows',coalesce((select jsonb_agg(to_jsonb(details) order by dispatched_at desc,id) from details),'[]'::jsonb)) into report;
  return report;
end
$$;
