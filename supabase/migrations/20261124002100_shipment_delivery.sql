alter table public.shipments add column delivered_at timestamptz;
alter table public.shipments add column delivery_recorded_at timestamptz;
alter table public.shipments add column delivery_recorded_by uuid references public.profiles;
alter table public.shipments add column delivery_reference text check (length(delivery_reference) <= 300);
alter table public.shipments add constraint shipment_delivery_metadata_check
  check ((delivered_at is null and delivery_recorded_at is null and delivery_recorded_by is null and delivery_reference is null)
    or (delivered_at is not null and delivery_recorded_at is not null and delivery_recorded_by is not null
      and delivered_at >= dispatched_at and delivered_at <= delivery_recorded_at));

create index shipments_dispatched_at_idx on public.shipments(dispatched_at desc,id);
create index shipments_pending_delivery_idx on public.shipments(dispatched_at desc,id) where delivered_at is null;

create function purezza_private.confirm_delivery(
  target_shipment uuid, actual_local timestamp without time zone, reference text, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  delivery_time timestamptz;
  recorded_time timestamptz := statement_timestamp();
  dispatch public.shipments%rowtype;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode confirmar entregas.';
  end if;
  previous := purezza_private.claim_operation('CONFIRMAR_ENTREGA',request_id,
    jsonb_build_array(target_shipment,actual_local,reference));
  if previous is not null then return previous; end if;

  select * into dispatch from public.shipments where id = target_shipment for update;
  if not found or dispatch.delivered_at is not null then
    raise exception using errcode = '22023', message = 'Selecione uma expedição com entrega pendente.';
  end if;
  delivery_time := coalesce(actual_local at time zone 'America/Sao_Paulo',recorded_time);
  if not isfinite(delivery_time) or delivery_time < dispatch.dispatched_at or delivery_time > recorded_time
    or length(reference) > 300 then
    raise exception using errcode = '22023', message = 'A entrega deve estar entre o despacho e o horário atual.';
  end if;

  update public.shipments set delivered_at = delivery_time, delivery_recorded_at = recorded_time,
    delivery_recorded_by = auth.uid(), delivery_reference = nullif(btrim(reference),'') where id = target_shipment;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'CONFIRMAR_ENTREGA',
    jsonb_build_object('expedicao_id',target_shipment,'entregue_em',delivery_time));
  update public.operation_requests set result = target_shipment
    where actor = auth.uid() and operation = 'CONFIRMAR_ENTREGA' and operation_requests.request_id = confirm_delivery.request_id;
  return target_shipment;
end
$$;

create function public.confirm_delivery(
  target_shipment uuid, actual_local timestamp without time zone, reference text, request_id uuid
)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.confirm_delivery(target_shipment,actual_local,reference,request_id)
$$;

create function purezza_private.shipment_history(pending_only boolean, page_size int, page_offset int)
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
      dispatch.delivered_at,dispatch.delivery_reference
    from paged dispatch
    join public.orders purchase on purchase.id = dispatch.order_id
    join public.stock_reservations res on res.id = dispatch.reservation_id
    join public.order_items entry on entry.id = res.order_item_id
    join public.inventory_lots lot on lot.id = res.lot_id
    join public.locations location on location.id = res.location_id
  )
  select jsonb_build_object('total',(select count(*) from eligible),
    'rows',coalesce((select jsonb_agg(to_jsonb(details) order by dispatched_at desc,id) from details),'[]'::jsonb)) into report;
  return report;
end
$$;

create function public.shipment_history(pending_only boolean, page_size int, page_offset int)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.shipment_history(pending_only,page_size,page_offset)
$$;
revoke all on function purezza_private.confirm_delivery(uuid,timestamp without time zone,text,uuid),
  public.confirm_delivery(uuid,timestamp without time zone,text,uuid),
  purezza_private.shipment_history(boolean,int,int), public.shipment_history(boolean,int,int)
  from public, anon, authenticated;
grant execute on function purezza_private.confirm_delivery(uuid,timestamp without time zone,text,uuid),
  public.confirm_delivery(uuid,timestamp without time zone,text,uuid),
  purezza_private.shipment_history(boolean,int,int), public.shipment_history(boolean,int,int)
  to authenticated;
