-- A transaction may emit several signals. No operational record is included in the payload.
create function purezza_private.signal_production_board()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    perform realtime.send('{}'::jsonb,'changed','production-board',true);
  end if;
  return null;
end
$$;
revoke all on function purezza_private.signal_production_board() from public,anon,authenticated;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    create policy production_board_broadcast_read on realtime.messages for select to authenticated
      using (extension='broadcast' and topic='production-board' and (select realtime.topic())='production-board'
        and (select purezza_private.has_role('ADMINISTRADOR','PRODUCAO','VENDAS')));
  end if;
end
$$;

create trigger production_board_batch_changed after insert or update on public.production_batches
  for each statement execute function purezza_private.signal_production_board();
create trigger production_board_stage_changed after insert or update on public.production_batch_stages
  for each statement execute function purezza_private.signal_production_board();
create trigger production_board_recall_changed after insert or update on public.recall_affected_batches
  for each statement execute function purezza_private.signal_production_board();
