alter table public.inventory_lots
  alter column receipt_id drop not null,
  add column opening_location_id uuid references public.locations,
  add column opening_reference text,
  add column opening_invoice text,
  add column opened_at timestamptz,
  add column opened_by uuid references public.profiles,
  add constraint inventory_lot_origin_check check (
    (receipt_id is not null and opening_location_id is null and opening_reference is null
      and opening_invoice is null and opened_at is null and opened_by is null)
    or (receipt_id is null and opening_location_id is not null and opened_at is not null
      and opened_by is not null and nullif(btrim(opening_reference), '') is not null)
  );

create unique index opening_lot_identity_idx
  on public.inventory_lots(item_id, manufacturer_id, original_lot) where receipt_id is null;

alter table public.stock_movements drop constraint stock_movements_kind_check;
alter table public.stock_movements add constraint stock_movements_kind_check
  check (kind in ('RECEBIMENTO', 'TRANSFERENCIA', 'AJUSTE_INVENTARIO', 'ABERTURA_INVENTARIO'));

create unique index stock_movements_one_opening_idx
  on public.stock_movements(lot_id) where kind = 'ABERTURA_INVENTARIO';

create function purezza_private.classify_opening_movement()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.kind = 'AJUSTE_INVENTARIO' and new.quantity_delta > 0
    and exists (
      select from public.inventory_lots where id = new.lot_id and receipt_id is null
        and opening_location_id = new.location_id
    )
    and not exists (
      select from public.stock_movements where lot_id = new.lot_id and kind = 'ABERTURA_INVENTARIO'
    ) then
    new.kind := 'ABERTURA_INVENTARIO';
  end if;
  return new;
end
$$;
revoke all on function purezza_private.classify_opening_movement() from public, anon, authenticated;
create trigger classify_opening_movement before insert on public.stock_movements
  for each row execute function purezza_private.classify_opening_movement();

create function purezza_private.guard_opening_lot_release()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.receipt_id is null and new.status = 'LIBERADO'
    and (nullif(btrim(new.opening_invoice), '') is null
      or not exists (
        select from public.stock_movements where lot_id = new.id and kind = 'ABERTURA_INVENTARIO'
      )) then
    raise exception using errcode = '22023', message = 'Liberação exige contagem inicial aprovada e documento de origem.';
  end if;
  return new;
end
$$;
revoke all on function purezza_private.guard_opening_lot_release() from public, anon, authenticated;
create trigger guard_opening_lot_release before update of status on public.inventory_lots
  for each row execute function purezza_private.guard_opening_lot_release();

create function purezza_private.open_inventory_lot(input jsonb, request_id uuid)
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
  on conflict (item_id, manufacturer_id, original_lot) where receipt_id is null do nothing returning id into lot;
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

create function public.open_inventory_lot(input jsonb, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.open_inventory_lot(input, request_id)
$$;
revoke all on function purezza_private.open_inventory_lot(jsonb,uuid), public.open_inventory_lot(jsonb,uuid)
  from public, anon, authenticated;
grant execute on function purezza_private.open_inventory_lot(jsonb,uuid), public.open_inventory_lot(jsonb,uuid)
  to authenticated;

create or replace function public.suggest_fefo_lots(target_item uuid, requested_quantity numeric)
returns table(lot_id uuid, location_id uuid, internal_code text, expires_on date, suggested_quantity numeric)
language sql stable set search_path = '' as $$
  with eligible as (
    select l.id, b.location_id, l.internal_code, l.expires_on, b.quantity,
      coalesce(r.received_at, l.opened_at) as origin_at,
      coalesce(sum(b.quantity) over (
        order by l.expires_on nulls last, coalesce(r.received_at, l.opened_at), l.id, b.location_id
        rows between unbounded preceding and 1 preceding
      ), 0) as already_covered
    from public.inventory_lots l
    left join public.receipts r on r.id = l.receipt_id
    join public.stock_balances b on b.lot_id = l.id
    join public.locations loc on loc.id = b.location_id and loc.active
    join public.items item on item.id = l.item_id and item.active
    where l.item_id = target_item and l.status = 'LIBERADO' and b.quantity > 0
      and ((l.expiry = 'INFORMADA' and l.expires_on > (statement_timestamp() at time zone 'America/Sao_Paulo')::date)
        or l.expiry = 'NAO_APLICAVEL')
      and requested_quantity > 0 and requested_quantity < 1000000000000
  )
  select id, location_id, internal_code, expires_on, least(quantity, requested_quantity - already_covered)
  from eligible where already_covered < requested_quantity
  order by expires_on nulls last, origin_at, id, location_id
$$;
