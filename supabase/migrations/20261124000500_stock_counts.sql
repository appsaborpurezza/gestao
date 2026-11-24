alter table public.stock_movements drop constraint stock_movements_kind_check;
alter table public.stock_movements add constraint stock_movements_kind_check
  check (kind in ('RECEBIMENTO', 'TRANSFERENCIA', 'AJUSTE_INVENTARIO'));

create table public.inventory_counts (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.inventory_lots,
  location_id uuid not null references public.locations,
  expected_quantity numeric(18,6) not null check (expected_quantity >= 0),
  counted_quantity numeric(18,6) not null check (counted_quantity >= 0),
  movement_count bigint not null check (movement_count >= 0),
  reason text not null check (btrim(reason) <> ''),
  counter_id uuid not null references public.profiles,
  counted_at timestamptz not null default statement_timestamp(),
  reviewer_id uuid references public.profiles,
  reviewed_at timestamptz,
  review_reason text,
  decision text check (decision in ('APROVADA','REJEITADA')),
  check ((decision is null and reviewer_id is null and reviewed_at is null and review_reason is null)
    or (decision is not null and reviewer_id is not null and reviewed_at is not null
        and nullif(btrim(review_reason), '') is not null))
);
create index inventory_counts_lot_location_idx on public.inventory_counts(lot_id, location_id);
alter table public.inventory_counts enable row level security;
revoke all on public.inventory_counts from public, anon, authenticated;
grant select on public.inventory_counts to authenticated;
create policy inventory_counts_operational_read on public.inventory_counts for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR', 'PRODUCAO')));

create function purezza_private.record_inventory_count(
  target_lot uuid, target_location uuid, amount numeric, reason text, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  count_id uuid;
  lot_unit text;
  physical numeric;
  revisions bigint;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode registrar contagens.';
  end if;
  previous := purezza_private.claim_operation('CONTAGEM', request_id,
    jsonb_build_array(target_lot, target_location, amount, reason));
  if previous is not null then return previous; end if;

  select unit into lot_unit from public.inventory_lots where id = target_lot for update;
  if not found or amount is null or not (amount >= 0 and amount < 1000000000000)
    or amount <> round(amount, 6) or (lot_unit = 'un' and amount <> trunc(amount))
    or nullif(btrim(reason), '') is null then
    raise exception using errcode = '22023', message = 'Confira lote, quantidade e motivo da contagem.';
  end if;
  perform id from public.locations where id = target_location and active for share;
  if not found then
    raise exception using errcode = '22023', message = 'Local inativo ou inexistente.';
  end if;

  select quantity into physical from public.stock_balances where lot_id = target_lot and location_id = target_location;
  select count(*) into revisions from public.stock_movements where lot_id = target_lot and location_id = target_location;

  insert into public.inventory_counts(lot_id, location_id, expected_quantity, counted_quantity, movement_count, reason, counter_id)
    values(target_lot, target_location, coalesce(physical, 0), amount, revisions, reason, auth.uid())
    returning id into count_id;
  update public.operation_requests set result = count_id
    where actor = auth.uid() and operation = 'CONTAGEM'
      and operation_requests.request_id = record_inventory_count.request_id;
  return count_id;
end
$$;

create function purezza_private.review_inventory_count(target_count uuid, approve boolean, reason text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  entry public.inventory_counts%rowtype;
  revisions bigint;
  delta numeric;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'A revisão exige perfil administrador.';
  end if;
  previous := purezza_private.claim_operation('REVISAO_CONTAGEM', request_id,
    jsonb_build_array(target_count, approve, reason));
  if previous is not null then return previous; end if;
  if approve is null or nullif(btrim(reason), '') is null then
    raise exception using errcode = '22023', message = 'Informe a decisão e a justificativa.';
  end if;

  select * into entry from public.inventory_counts where id = target_count for update;
  if not found or entry.decision is not null then
    raise exception using errcode = '22023', message = 'A contagem precisa estar pendente de revisão.';
  end if;

  if approve then
    perform id from public.inventory_lots where id = entry.lot_id for update;
    perform id from public.locations where id = entry.location_id and active for share;
    if not found then
      raise exception using errcode = '22023', message = 'O local da contagem está inativo.';
    end if;
    select count(*) into revisions from public.stock_movements
      where lot_id = entry.lot_id and location_id = entry.location_id;
    if revisions <> entry.movement_count then
      raise exception using errcode = '40001', message = 'O estoque mudou após a contagem. Registre uma nova contagem.';
    end if;

    delta := entry.counted_quantity - entry.expected_quantity;
    if delta <> 0 then
      insert into public.stock_balances(lot_id, location_id, quantity)
        values(entry.lot_id, entry.location_id, entry.counted_quantity)
        on conflict(lot_id, location_id) do update set quantity = excluded.quantity;
      insert into public.stock_movements(lot_id, location_id, quantity_delta, kind, actor, correlation_id)
        values(entry.lot_id, entry.location_id, delta, 'AJUSTE_INVENTARIO', auth.uid(), entry.id);
    end if;
  end if;

  update public.inventory_counts set decision = case when approve then 'APROVADA' else 'REJEITADA' end,
    reviewer_id = auth.uid(), reviewed_at = statement_timestamp(),
    review_reason = review_inventory_count.reason where id = target_count;
  update public.operation_requests set result = target_count
    where actor = auth.uid() and operation = 'REVISAO_CONTAGEM'
      and operation_requests.request_id = review_inventory_count.request_id;
  return target_count;
end
$$;

create function public.record_inventory_count(
  target_lot uuid, target_location uuid, amount numeric, reason text, request_id uuid
)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.record_inventory_count(target_lot, target_location, amount, reason, request_id)
$$;

create function public.review_inventory_count(target_count uuid, approve boolean, reason text, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.review_inventory_count(target_count, approve, reason, request_id)
$$;

revoke all on function purezza_private.record_inventory_count(uuid,uuid,numeric,text,uuid),
  public.record_inventory_count(uuid,uuid,numeric,text,uuid),
  purezza_private.review_inventory_count(uuid,boolean,text,uuid),
  public.review_inventory_count(uuid,boolean,text,uuid) from public, anon, authenticated;
grant execute on function purezza_private.record_inventory_count(uuid,uuid,numeric,text,uuid),
  public.record_inventory_count(uuid,uuid,numeric,text,uuid),
  purezza_private.review_inventory_count(uuid,boolean,text,uuid),
  public.review_inventory_count(uuid,boolean,text,uuid) to authenticated;
