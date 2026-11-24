create table public.inventory_sessions (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations,
  reason text not null check (nullif(btrim(reason), '') is not null),
  opened_by uuid not null references public.profiles,
  opened_at timestamptz not null default statement_timestamp(),
  closed_by uuid references public.profiles,
  closed_at timestamptz,
  close_reason text,
  unique (id, location_id),
  check ((closed_at is null and closed_by is null and close_reason is null)
    or (closed_at is not null and closed_by is not null and nullif(btrim(close_reason), '') is not null))
);

create unique index inventory_sessions_one_open_per_location_idx
  on public.inventory_sessions(location_id) where closed_at is null;

alter table public.inventory_counts add column session_id uuid;
alter table public.inventory_counts add constraint inventory_counts_session_location_fk
  foreign key (session_id, location_id) references public.inventory_sessions(id, location_id);
create index inventory_counts_session_idx on public.inventory_counts(session_id) where session_id is not null;
create unique index inventory_counts_session_lot_idx on public.inventory_counts(session_id, lot_id)
  where session_id is not null and decision is distinct from 'REJEITADA';

alter table public.inventory_sessions enable row level security;
revoke all on public.inventory_sessions from public, anon, authenticated;
grant select on public.inventory_sessions to authenticated;
create policy inventory_sessions_operational_read on public.inventory_sessions for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR','PRODUCAO')));

create function purezza_private.open_inventory_session(target_location uuid, reason text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode abrir sessões de inventário.';
  end if;
  result_id := purezza_private.claim_operation('ABRIR_SESSAO_INVENTARIO', request_id,
    jsonb_build_array(target_location, reason));
  if result_id is not null then return result_id; end if;

  perform id from public.locations where id = target_location and active for share;
  if not found then
    raise exception using errcode = '22023', message = 'Selecione um local ativo.';
  end if;
  insert into public.inventory_sessions(location_id, reason, opened_by)
    values(target_location, open_inventory_session.reason, auth.uid())
    on conflict(location_id) where closed_at is null do nothing
    returning id into result_id;
  if result_id is null then
    raise exception using errcode = '23505', message = 'Já existe uma sessão aberta neste local.';
  end if;

  update public.operation_requests set result = result_id
    where actor = auth.uid() and operation = 'ABRIR_SESSAO_INVENTARIO'
      and operation_requests.request_id = open_inventory_session.request_id;
  return result_id;
end
$$;

create function purezza_private.record_session_count(
  target_session uuid, target_lot uuid, amount numeric, reason text, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  session_location uuid;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode registrar contagens.';
  end if;
  result_id := purezza_private.claim_operation('CONTAGEM_SESSAO', request_id,
    jsonb_build_array(target_session, target_lot, amount, reason));
  if result_id is not null then return result_id; end if;

  select location_id into session_location from public.inventory_sessions
    where id = target_session and closed_at is null for update;
  if not found then
    raise exception using errcode = '22023', message = 'A sessão precisa estar aberta.';
  end if;
  if exists(select from public.inventory_counts where session_id = target_session
    and lot_id = target_lot and decision is distinct from 'REJEITADA') then
    raise exception using errcode = '23505', message = 'Este lote já tem uma contagem pendente ou aprovada na sessão.';
  end if;

  result_id := purezza_private.record_inventory_count(target_lot, session_location, amount, reason, gen_random_uuid());
  update public.inventory_counts set session_id = target_session where id = result_id;
  update public.operation_requests set result = result_id
    where actor = auth.uid() and operation = 'CONTAGEM_SESSAO'
      and operation_requests.request_id = record_session_count.request_id;
  return result_id;
end
$$;

create function purezza_private.close_inventory_session(target_session uuid, reason text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'O encerramento exige perfil administrador.';
  end if;
  result_id := purezza_private.claim_operation('FECHAR_SESSAO_INVENTARIO', request_id,
    jsonb_build_array(target_session, reason));
  if result_id is not null then return result_id; end if;

  perform id from public.inventory_sessions where id = target_session and closed_at is null for update;
  if not found then
    raise exception using errcode = '22023', message = 'A sessão precisa estar aberta.';
  end if;
  if exists(select from public.inventory_counts where session_id = target_session and decision is null) then
    raise exception using errcode = '22023', message = 'Revise as contagens pendentes antes de encerrar.';
  end if;

  update public.inventory_sessions set closed_at = statement_timestamp(), closed_by = auth.uid(),
    close_reason = close_inventory_session.reason where id = target_session;
  update public.operation_requests set result = target_session
    where actor = auth.uid() and operation = 'FECHAR_SESSAO_INVENTARIO'
      and operation_requests.request_id = close_inventory_session.request_id;
  return target_session;
end
$$;

create function public.open_inventory_session(target_location uuid, reason text, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.open_inventory_session(target_location, reason, request_id)
$$;
create function public.record_session_count(target_session uuid, target_lot uuid, amount numeric, reason text, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.record_session_count(target_session, target_lot, amount, reason, request_id)
$$;
create function public.close_inventory_session(target_session uuid, reason text, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.close_inventory_session(target_session, reason, request_id)
$$;

revoke all on function purezza_private.open_inventory_session(uuid,text,uuid), public.open_inventory_session(uuid,text,uuid),
  purezza_private.record_session_count(uuid,uuid,numeric,text,uuid), public.record_session_count(uuid,uuid,numeric,text,uuid),
  purezza_private.close_inventory_session(uuid,text,uuid), public.close_inventory_session(uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function purezza_private.open_inventory_session(uuid,text,uuid), public.open_inventory_session(uuid,text,uuid),
  purezza_private.record_session_count(uuid,uuid,numeric,text,uuid), public.record_session_count(uuid,uuid,numeric,text,uuid),
  purezza_private.close_inventory_session(uuid,text,uuid), public.close_inventory_session(uuid,text,uuid)
  to authenticated;
