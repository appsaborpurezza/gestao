create table public.inventory_label_requests (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.inventory_lots,
  actor uuid not null references public.profiles,
  requested_at timestamptz not null default statement_timestamp(),
  label_snapshot jsonb not null
);
create index inventory_label_requests_lot_idx on public.inventory_label_requests(lot_id, requested_at);
alter table public.inventory_label_requests enable row level security;
revoke all on public.inventory_label_requests from public, anon, authenticated;
grant select on public.inventory_label_requests to authenticated;
create policy inventory_label_requests_admin_read on public.inventory_label_requests for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR')));

create function purezza_private.request_inventory_label(target_lot uuid, request_id uuid)
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
    'document', coalesce(receipt.invoice_number, lot.opening_invoice),
    'document_type', case when receipt.id is null then 'Documento de origem' else 'NF' end
  ) into snapshot
  from public.inventory_lots lot
  join public.items item on item.id = lot.item_id
  join public.manufacturers maker on maker.id = lot.manufacturer_id
  left join public.receipts receipt on receipt.id = lot.receipt_id
  join public.stock_movements first_movement on first_movement.lot_id = lot.id
    and first_movement.kind in ('RECEBIMENTO', 'ABERTURA_INVENTARIO')
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

create function public.request_inventory_label(target_lot uuid, request_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select purezza_private.request_inventory_label(target_lot, request_id)
$$;
revoke all on function purezza_private.request_inventory_label(uuid,uuid),
  public.request_inventory_label(uuid,uuid) from public, anon, authenticated;
grant execute on function purezza_private.request_inventory_label(uuid,uuid),
  public.request_inventory_label(uuid,uuid) to authenticated;
