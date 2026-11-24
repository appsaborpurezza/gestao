create table public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references public.order_items,
  lot_id uuid not null,
  location_id uuid not null,
  quantity numeric(18,6) not null check (quantity > 0 and quantity <> 'NaN'::numeric),
  reserved_by uuid not null references public.profiles,
  reserved_at timestamptz not null default statement_timestamp(),
  released_by uuid references public.profiles,
  released_at timestamptz,
  release_reason text,
  foreign key (lot_id, location_id) references public.stock_balances,
  check ((released_at is null and released_by is null and release_reason is null)
    or (released_at is not null and released_by is not null and nullif(btrim(release_reason),'') is not null))
);
create index stock_reservations_order_item_idx on public.stock_reservations(order_item_id);
create index stock_reservations_active_position_idx on public.stock_reservations(lot_id,location_id) where released_at is null;

alter table public.stock_reservations enable row level security;
revoke all on public.stock_reservations from public, anon, authenticated;
grant select on public.stock_reservations to authenticated;
create policy stock_reservations_operational_read on public.stock_reservations for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR','PRODUCAO')));

create function purezza_private.guard_reserved_balance()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.quantity < old.quantity and new.quantity < (
    select coalesce(sum(quantity),0) from public.stock_reservations
      where lot_id = new.lot_id and location_id = new.location_id and released_at is null
  ) then
    raise exception using errcode = '22023', message = 'A operação comprometeria saldo reservado neste local.';
  end if;
  return new;
end
$$;
revoke all on function purezza_private.guard_reserved_balance() from public, anon, authenticated;
create trigger guard_reserved_balance before update of quantity on public.stock_balances
  for each row execute function purezza_private.guard_reserved_balance();

create function purezza_private.reserve_order_stock(target_line uuid, amount numeric, request_id uuid)
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
  if not found or purchase.fulfillment_status <> 'CONFIRMADO' then
    raise exception using errcode = '22023', message = 'Selecione um item de pedido confirmado.';
  end if;
  select * into strict line from public.order_items where id = target_line and order_id = purchase.id;
  if line.confirmed_classification is null or line.confirmed_classification = 'FABRICACAO_PROPRIA' then
    raise exception using errcode = '22023', message = 'Este fluxo atende somente itens de terceiros ou revenda.';
  end if;
  if amount is null or not (amount > 0 and amount <= line.quantity)
    or amount <> round(amount,6) or (line.unit = 'un' and amount <> trunc(amount))
    or amount > line.quantity - (select coalesce(sum(quantity),0) from public.stock_reservations
      where order_item_id = target_line and released_at is null) then
    raise exception using errcode = '22023', message = 'Confira a quantidade ainda não reservada neste item.';
  end if;
  perform id from public.items where id = line.item_id and active for share;
  if not found then raise exception using errcode = '22023', message = 'O produto precisa estar ativo.'; end if;

  cutoff := greatest(cutoff,purchase.delivery_date);

  -- Lock lot rows first, in a common order, then calculate quantities from committed reservations.
  select array(select id from public.inventory_lots where item_id = line.item_id and unit = line.unit
    and status = 'LIBERADO' and (expiry = 'NAO_APLICAVEL' or (expiry = 'INFORMADA' and expires_on > cutoff))
    order by id for update) into eligible_lots;
  for slot in
    select lot.id lot_id, balance.location_id, balance.quantity - coalesce((
      select sum(quantity) from public.stock_reservations where lot_id = lot.id
        and location_id = balance.location_id and released_at is null
    ),0) as available
    from public.inventory_lots lot
    join public.stock_balances balance on balance.lot_id = lot.id
    join public.locations location on location.id = balance.location_id and location.active
    left join public.receipts receipt on receipt.id = lot.receipt_id
    where lot.id = any(eligible_lots) and lot.status = 'LIBERADO'
      and (lot.expiry = 'NAO_APLICAVEL' or (lot.expiry = 'INFORMADA' and lot.expires_on > cutoff))
      and balance.quantity > 0
    order by lot.expires_on nulls last, coalesce(receipt.received_at,lot.opened_at),lot.id,balance.location_id
    for share of location
  loop
    if slot.available <= 0 then continue; end if;
    allocation := least(rest,slot.available);
    insert into public.stock_reservations(order_item_id,lot_id,location_id,quantity,reserved_by)
      values(target_line,slot.lot_id,slot.location_id,allocation,auth.uid()) returning id into reservation_id;
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

create function purezza_private.release_stock_reservation(target_reservation uuid, reason text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  target_lot uuid;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'A liberação da reserva exige perfil administrador.';
  end if;
  previous := purezza_private.claim_operation('LIBERAR_RESERVA_ESTOQUE',request_id,
    jsonb_build_array(target_reservation,reason));
  if previous is not null then return previous; end if;
  if nullif(btrim(reason),'') is null or length(reason) > 500 then
    raise exception using errcode = '22023', message = 'Informe o motivo da liberação.';
  end if;
  select lot_id into target_lot from public.stock_reservations where id = target_reservation;
  perform id from public.inventory_lots where id = target_lot for update;
  update public.stock_reservations set released_at = statement_timestamp(), released_by = auth.uid(),
    release_reason = reason where id = target_reservation and released_at is null;
  if not found then
    raise exception using errcode = '22023', message = 'Selecione uma reserva ativa.';
  end if;

  insert into public.audit_logs(actor,action,details) values(auth.uid(),'LIBERAR_RESERVA_ESTOQUE',
    jsonb_build_object('reserva_id',target_reservation));
  update public.operation_requests set result = target_reservation
    where actor = auth.uid() and operation = 'LIBERAR_RESERVA_ESTOQUE'
      and operation_requests.request_id = release_stock_reservation.request_id;
  return target_reservation;
end
$$;

create function public.reserve_order_stock(target_line uuid, amount numeric, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.reserve_order_stock(target_line,amount,request_id)
$$;
create function public.release_stock_reservation(target_reservation uuid, reason text, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.release_stock_reservation(target_reservation,reason,request_id)
$$;
revoke all on function purezza_private.reserve_order_stock(uuid,numeric,uuid), public.reserve_order_stock(uuid,numeric,uuid),
  purezza_private.release_stock_reservation(uuid,text,uuid), public.release_stock_reservation(uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function purezza_private.reserve_order_stock(uuid,numeric,uuid), public.reserve_order_stock(uuid,numeric,uuid),
  purezza_private.release_stock_reservation(uuid,text,uuid), public.release_stock_reservation(uuid,text,uuid) to authenticated;

create or replace function public.suggest_fefo_lots(target_item uuid, requested_quantity numeric)
returns table(lot_id uuid, location_id uuid, internal_code text, expires_on date, suggested_quantity numeric)
language sql stable set search_path = '' as $$
  with positions as (
    select lot.id, b.location_id, lot.internal_code, lot.expires_on, coalesce(r.received_at,lot.opened_at) as origin_at,
      b.quantity - coalesce((
        select sum(res.quantity) from public.stock_reservations res
        where res.lot_id = lot.id and res.location_id = b.location_id and res.released_at is null
      ),0) as available
    from public.inventory_lots lot
    left join public.receipts r on r.id = lot.receipt_id
    join public.stock_balances b on b.lot_id = lot.id
    join public.locations loc on loc.id = b.location_id and loc.active
    join public.items item on item.id = lot.item_id and item.active
    where lot.item_id = target_item and lot.status = 'LIBERADO' and b.quantity > 0
      and (lot.expiry = 'NAO_APLICAVEL' or (lot.expiry = 'INFORMADA'
        and lot.expires_on > (statement_timestamp() at time zone 'America/Sao_Paulo')::date))
      and requested_quantity > 0 and requested_quantity < 1000000000000
  ), eligible as (
    select p.*, coalesce(sum(p.available) over (
      order by p.expires_on nulls last,p.origin_at,p.id,p.location_id
      rows between unbounded preceding and 1 preceding
    ),0) as covered
    from positions p where p.available > 0
  )
  select e.id,e.location_id,e.internal_code,e.expires_on,least(e.available,requested_quantity-e.covered)
  from eligible e where e.covered < requested_quantity
  order by e.expires_on nulls last,e.origin_at,e.id,e.location_id
$$;
