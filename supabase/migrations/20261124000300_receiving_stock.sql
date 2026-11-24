create type public.lot_status as enum ('QUARENTENA', 'LIBERADO', 'BLOQUEADO', 'REPROVADO');
create type public.expiry_basis as enum ('INFORMADA', 'DESCONHECIDA', 'NAO_APLICAVEL');

alter table public.items add column base_unit text check (base_unit in ('kg','g','L','mL','un'));

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  code text unique not null check (btrim(code) <> ''),
  active boolean not null default true
);
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  active boolean not null default true
);
create table public.manufacturers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  active boolean not null default true
);
create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers,
  invoice_number text,
  documentation_reason text,
  received_at timestamptz not null default statement_timestamp(),
  actor uuid not null references public.profiles,
  check (nullif(btrim(invoice_number), '') is not null or nullif(btrim(documentation_reason), '') is not null)
);
create index receipts_supplier_idx on public.receipts(supplier_id);
create table public.inventory_lots (
  id uuid primary key default gen_random_uuid(),
  internal_code text generated always as ('REC-' || replace(id::text, '-', '')) stored unique,
  receipt_id uuid not null unique references public.receipts,
  item_id uuid not null references public.items,
  manufacturer_id uuid not null references public.manufacturers,
  original_lot text not null check (btrim(original_lot) <> ''),
  manufactured_on date,
  expires_on date,
  expiry public.expiry_basis not null,
  expiry_reason text,
  unit text not null check (unit in ('kg','g','L','mL','un')),
  status public.lot_status not null default 'QUARENTENA',
  version int not null default 1,
  check ((expiry = 'INFORMADA') = (expires_on is not null)),
  check (expiry <> 'NAO_APLICAVEL' or nullif(btrim(expiry_reason), '') is not null),
  check (expires_on >= manufactured_on)
);
create index inventory_lots_fefo_idx on public.inventory_lots(item_id, status, expires_on);
create index inventory_lots_manufacturer_idx on public.inventory_lots(manufacturer_id);
create table public.stock_balances (
  lot_id uuid not null references public.inventory_lots,
  location_id uuid not null references public.locations,
  quantity numeric(18,6) not null check (quantity >= 0 and quantity <> 'NaN'::numeric),
  primary key (lot_id, location_id)
);
create index stock_balances_location_idx on public.stock_balances(location_id);
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null,
  location_id uuid not null,
  quantity_delta numeric(18,6) not null check (quantity_delta <> 0 and quantity_delta <> 'NaN'::numeric),
  kind text not null check (kind in ('RECEBIMENTO', 'TRANSFERENCIA')),
  actor uuid not null references public.profiles,
  correlation_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  foreign key (lot_id, location_id) references public.stock_balances
);
create index stock_movements_position_idx on public.stock_movements(lot_id, location_id, created_at);
create table public.lot_releases (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.inventory_lots,
  old_status public.lot_status not null,
  new_status public.lot_status not null,
  reason text not null check (btrim(reason) <> ''),
  actor uuid not null references public.profiles,
  created_at timestamptz not null default statement_timestamp()
);
create index lot_releases_lot_idx on public.lot_releases(lot_id);
create table public.operation_requests (
  actor uuid not null references public.profiles,
  operation text not null,
  request_id uuid not null,
  payload jsonb not null,
  result uuid,
  created_at timestamptz not null default statement_timestamp(),
  primary key (actor, operation, request_id)
);
alter table public.operation_requests enable row level security;
revoke all on public.operation_requests from public, anon, authenticated;

do $$
declare relation text;
begin
  foreach relation in array array['locations','suppliers','manufacturers','receipts','inventory_lots',
                                  'stock_balances','stock_movements','lot_releases'] loop
    execute format('alter table public.%I enable row level security', relation);
    execute format('revoke all on public.%I from public, anon, authenticated', relation);
    execute format('grant select on public.%I to authenticated', relation);
    execute format('create policy operational_read on public.%I for select to authenticated
      using ((select purezza_private.has_role(''ADMINISTRADOR'', ''PRODUCAO'')))', relation);
  end loop;
end
$$;

create function purezza_private.claim_operation(op text, key uuid, input jsonb)
returns uuid language plpgsql set search_path = '' as $$
declare existing public.operation_requests%rowtype;
begin
  if key is null then raise exception using errcode = '22023', message = 'Informe a chave de idempotência.'; end if;
  insert into public.operation_requests(actor, operation, request_id, payload)
  values (auth.uid(), op, key, input) on conflict do nothing;
  select * into strict existing from public.operation_requests
    where actor = auth.uid() and operation = op and request_id = key for update;
  if existing.payload is distinct from input then
    raise exception using errcode = '22023', message = 'A chave já foi usada com outros dados.';
  end if;
  return existing.result;
end
$$;
revoke all on function purezza_private.claim_operation(text, uuid, jsonb) from public, anon, authenticated;

create function purezza_private.receive_stock(input jsonb, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  lot uuid;
  receipt uuid;
  item uuid := (input->>'item_id')::uuid;
  supplier uuid := (input->>'supplier_id')::uuid;
  maker uuid := (input->>'manufacturer_id')::uuid;
  location uuid := (input->>'location_id')::uuid;
  amount numeric := (input->>'quantity')::numeric;
  unit_name text;
  manufacture date := (input->>'manufactured_on')::date;
  today date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode registrar recebimento.';
  end if;
  lot := purezza_private.claim_operation('RECEBIMENTO', request_id, input);
  if lot is not null then return lot; end if;

  select base_unit into unit_name from public.items where id = item and active for share;
  if unit_name is null or input->>'unit' is distinct from unit_name
    or amount is null or not (amount > 0 and amount < 1000000000000)
    or amount <> round(amount, 6) or (unit_name = 'un' and amount <> trunc(amount))
    or manufacture > today then
    raise exception using errcode = '22023', message = 'Confira unidade base, quantidade e data de fabricação.';
  end if;

  perform from public.suppliers where id = supplier and active for share;
  if not found then raise exception using errcode = '22023', message = 'Fornecedor inativo ou inexistente.'; end if;
  perform from public.manufacturers where id = maker and active for share;
  if not found then raise exception using errcode = '22023', message = 'Fabricante inativo ou inexistente.'; end if;
  perform from public.locations where id = location and active for share;
  if not found then raise exception using errcode = '22023', message = 'Localização inativa ou inexistente.'; end if;

  insert into public.receipts(supplier_id, invoice_number, documentation_reason, actor)
  values(supplier, nullif(btrim(input->>'invoice_number'), ''), input->>'documentation_reason', auth.uid())
  returning id into receipt;
  insert into public.inventory_lots(receipt_id, item_id, manufacturer_id, original_lot, manufactured_on,
      expires_on, expiry, expiry_reason, unit)
  values(receipt, item, maker, input->>'original_lot', manufacture, (input->>'expires_on')::date,
      (input->>'expiry')::public.expiry_basis, input->>'expiry_reason', unit_name)
  returning id into lot;
  insert into public.stock_balances values(lot, location, amount);
  insert into public.stock_movements(lot_id, location_id, quantity_delta, kind, actor, correlation_id)
    values(lot, location, amount, 'RECEBIMENTO', auth.uid(), request_id);
  update public.operation_requests set result = lot
    where actor = auth.uid() and operation = 'RECEBIMENTO' and operation_requests.request_id = receive_stock.request_id;
  return lot;
end
$$;

create function purezza_private.decide_lot(target uuid, expected_version int, decision public.lot_status, reason text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  lot public.inventory_lots%rowtype;
  previous uuid;
  authorized boolean;
  today date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'A decisão de estoque exige perfil administrador.';
  end if;
  select can_release_lot into authorized from public.profiles where id = auth.uid() and active for share;
  if not found or (decision = 'LIBERADO' and not authorized) then
    raise exception using errcode = '42501', message = 'A liberação exige autorização sanitária específica.';
  end if;

  previous := purezza_private.claim_operation('DECISAO_LOTE', request_id,
    jsonb_build_array(target, expected_version, decision, reason));
  if previous is not null then return previous; end if;

  select * into strict lot from public.inventory_lots where id = target for update;
  if lot.version is distinct from expected_version then
    raise exception using errcode = '40001', message = 'O lote mudou. Atualize a consulta.';
  end if;

  if decision is null or decision in (lot.status, 'QUARENTENA') or lot.status = 'REPROVADO' then
    raise exception using errcode = '22023', message = 'Decisão incompatível com o estado atual.';
  end if;

  if decision = 'LIBERADO' and (lot.expiry = 'DESCONHECIDA' or lot.expires_on <= today
    or exists (select from public.receipts where id = lot.receipt_id and invoice_number is null)) then
    raise exception using errcode = '22023', message = 'Confira validade e documentação antes da liberação.';
  end if;

  update public.inventory_lots set status = decision, version = version + 1 where id = target;
  insert into public.lot_releases(lot_id, old_status, new_status, reason, actor)
    values(target, lot.status, decision, reason, auth.uid());
  update public.operation_requests set result = target
    where actor = auth.uid() and operation = 'DECISAO_LOTE' and operation_requests.request_id = decide_lot.request_id;
  return target;
end
$$;

create function public.receive_stock(input jsonb, request_id uuid)
returns uuid language sql set search_path = '' as $$
  select purezza_private.receive_stock(input, request_id)
$$;
create function public.decide_inventory_lot(target uuid, expected_version int, decision public.lot_status, reason text, request_id uuid)
returns uuid language sql set search_path = '' as $$
  select purezza_private.decide_lot(target, expected_version, decision, reason, request_id)
$$;
revoke all on function purezza_private.receive_stock(jsonb, uuid),
  purezza_private.decide_lot(uuid,int,public.lot_status,text,uuid),
  public.receive_stock(jsonb, uuid), public.decide_inventory_lot(uuid,int,public.lot_status,text,uuid)
  from public, anon, authenticated;
grant execute on function purezza_private.receive_stock(jsonb, uuid),
  purezza_private.decide_lot(uuid,int,public.lot_status,text,uuid),
  public.receive_stock(jsonb, uuid), public.decide_inventory_lot(uuid,int,public.lot_status,text,uuid)
  to authenticated;

create function public.suggest_fefo_lots(target_item uuid, requested_quantity numeric)
returns table(lot_id uuid, location_id uuid, internal_code text, expires_on date, suggested_quantity numeric)
language sql stable set search_path = '' as $$
  with eligible as (
    select l.id, b.location_id, l.internal_code, l.expires_on, b.quantity, r.received_at,
      coalesce(sum(b.quantity) over (
        order by l.expires_on nulls last, r.received_at, l.id, b.location_id
        rows between unbounded preceding and 1 preceding
      ), 0) as already_covered
    from public.inventory_lots l
    join public.receipts r on r.id = l.receipt_id
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
  order by expires_on nulls last, received_at, id, location_id
$$;
revoke all on function public.suggest_fefo_lots(uuid,numeric) from public, anon, authenticated;
grant execute on function public.suggest_fefo_lots(uuid,numeric) to authenticated;
