create table public.production_board_revision (
  id boolean primary key default true check(id),
  revision bigint not null default 0 check(revision>=0)
);
insert into public.production_board_revision default values;
alter table public.production_board_revision enable row level security;
revoke all on public.production_board_revision from public,anon,authenticated;
grant select on public.production_board_revision to authenticated;
create policy production_board_revision_read on public.production_board_revision for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR','PRODUCAO','VENDAS')));

create or replace function purezza_private.signal_production_board()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- A refresh signal must never make an operational transaction wait behind another signal.
  update public.production_board_revision set revision=revision+1
  where id in (select id from public.production_board_revision where id for update skip locked);
  return null;
end
$$;

do $$
begin
  if exists(select from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.production_board_revision;
  end if;
end
$$;
