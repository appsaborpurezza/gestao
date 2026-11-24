alter table public.production_batch_stages drop constraint stage_status_metadata_check;
alter table public.production_batch_stages add constraint stage_status_metadata_check check (
  (status in ('EM_EXECUCAO','PAUSADA') and finished_at is null and finished_by is null)
  or (status='CONCLUIDA' and finished_at is not null and finished_by is not null and finished_at>=started_at)
);
drop index public.production_batch_one_running_stage_idx;
create unique index production_batch_one_open_stage_idx on public.production_batch_stages(batch_id)
  where status in ('EM_EXECUCAO','PAUSADA');

create table public.production_stage_pauses (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  stage text not null,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  paused_at timestamptz not null,
  paused_by uuid not null references public.profiles,
  resumed_at timestamptz,
  resumed_by uuid references public.profiles,
  foreign key(batch_id,stage) references public.production_batch_stages(batch_id,stage),
  check ((resumed_at is null and resumed_by is null)
    or (resumed_at is not null and resumed_by is not null and resumed_at>=paused_at))
);
create index production_stage_pauses_stage_idx on public.production_stage_pauses(batch_id,stage,paused_at);
create unique index production_stage_pauses_one_open_idx on public.production_stage_pauses(batch_id,stage) where resumed_at is null;

alter table public.production_stage_pauses enable row level security;
revoke all on public.production_stage_pauses from public,anon,authenticated;
grant select on public.production_stage_pauses to authenticated;
create policy production_stage_pauses_technical_read on public.production_stage_pauses for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR','PRODUCAO')));

create function purezza_private.require_running_stage_for_consumption()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists(select from public.production_batch_stages where batch_id=new.batch_id and stage=new.stage and status='EM_EXECUCAO') then
    raise exception using errcode='22023',message='Retome a etapa antes de registrar novos consumos ou medições.';
  end if;
  return new;
end
$$;
revoke all on function purezza_private.require_running_stage_for_consumption() from public,anon,authenticated;
create trigger require_running_stage_for_ingredient before insert on public.batch_ingredient_consumptions
  for each row execute function purezza_private.require_running_stage_for_consumption();
create trigger require_running_stage_for_water before insert on public.batch_water_records
  for each row execute function purezza_private.require_running_stage_for_consumption();

create function purezza_private.change_production_stage_pause(
  target_batch uuid,expected_version int,pause boolean,reason text,request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  batch public.production_batches%rowtype;
  current_stage public.production_batch_stages%rowtype;
  action_time timestamptz;
  session_id uuid;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode='42501',message='Seu perfil não pode pausar ou retomar etapas.';
  end if;
  if pause is null or (pause and (nullif(btrim(reason),'') is null or length(btrim(reason))>500)) then
    raise exception using errcode='22023',message='Informe o motivo da pausa.';
  end if;
  previous := purezza_private.claim_operation('PAUSA_ETAPA_PRODUCAO',request_id,
    jsonb_build_array(target_batch,expected_version,pause,reason));
  if previous is not null then return previous; end if;

  select * into batch from public.production_batches where id=target_batch for update;
  if not found or batch.version is distinct from expected_version then
    raise exception using errcode='40001',message='A massada mudou. Atualize o quadro.';
  end if;
  select * into current_stage from public.production_batch_stages where batch_id=target_batch
    and status in ('EM_EXECUCAO','PAUSADA') for update;
  if not found or (pause and current_stage.status<>'EM_EXECUCAO') or (not pause and current_stage.status<>'PAUSADA') then
    raise exception using errcode='22023',message='A etapa não está no estado esperado para esta ação.';
  end if;

  action_time := clock_timestamp();
  if pause then
    if action_time<current_stage.started_at then
      raise exception using errcode='22023',message='O horário da pausa é anterior ao início da etapa.';
    end if;
    insert into public.production_stage_pauses(batch_id,stage,reason,paused_at,paused_by)
      values(target_batch,current_stage.stage,btrim(reason),action_time,auth.uid()) returning id into session_id;
  else
    update public.production_stage_pauses set resumed_at=action_time,resumed_by=auth.uid()
      where batch_id=target_batch and stage=current_stage.stage and resumed_at is null returning id into session_id;
    if session_id is null then raise exception using errcode='22023',message='A etapa não tem pausa aberta.'; end if;
  end if;
  update public.production_batch_stages set status=case when pause then 'PAUSADA' else 'EM_EXECUCAO' end
    where batch_id=target_batch and stage=current_stage.stage;
  update public.production_batches set version=version+1 where id=target_batch;

  insert into public.audit_logs(actor,action,details) values(auth.uid(),
    case when pause then 'PAUSAR_ETAPA' else 'RETOMAR_ETAPA' end,
    jsonb_build_object('massada_id',target_batch,'etapa',current_stage.stage,'pausa_id',session_id));
  update public.operation_requests set result=session_id
    where actor=auth.uid() and operation='PAUSA_ETAPA_PRODUCAO'
      and operation_requests.request_id=change_production_stage_pause.request_id;
  return session_id;
end
$$;

create function public.change_production_stage_pause(
  target_batch uuid,expected_version int,pause boolean,reason text,request_id uuid
)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.change_production_stage_pause(target_batch,expected_version,pause,reason,request_id)
$$;

create function public.production_stage_times(target_batch uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode='42501',message='Seu perfil não pode consultar o histórico de etapas.';
  end if;
  with elapsed as (
    select stage.stage,stage.status,stage.started_at,stage.finished_at,
      greatest(0,extract(epoch from coalesce(stage.finished_at,statement_timestamp())-stage.started_at)) as total_seconds,
      coalesce(pause.seconds,0) as pause_seconds,coalesce(pause.history,'[]'::jsonb) as pauses
    from public.production_batch_stages stage
    left join lateral (
      select sum(greatest(0,extract(epoch from coalesce(entry.resumed_at,stage.finished_at,statement_timestamp())-entry.paused_at))) as seconds,
        jsonb_agg(jsonb_build_object('id',entry.id,'reason',entry.reason,'paused_at',entry.paused_at,'resumed_at',entry.resumed_at)
          order by entry.paused_at,entry.id) as history
      from public.production_stage_pauses entry where entry.batch_id=stage.batch_id and entry.stage=stage.stage
    ) pause on true
    where stage.batch_id=target_batch
  )
  select coalesce(jsonb_agg(to_jsonb(elapsed) || jsonb_build_object(
    'net_seconds',greatest(0,floor(total_seconds-pause_seconds)),
    'paused_seconds',floor(pause_seconds)) order by started_at,stage),'[]'::jsonb)
  into result from elapsed;
  return result;
end
$$;

revoke all on function purezza_private.change_production_stage_pause(uuid,int,boolean,text,uuid),
  public.change_production_stage_pause(uuid,int,boolean,text,uuid),public.production_stage_times(uuid)
  from public,anon,authenticated;
grant execute on function purezza_private.change_production_stage_pause(uuid,int,boolean,text,uuid),
  public.change_production_stage_pause(uuid,int,boolean,text,uuid),public.production_stage_times(uuid)
  to authenticated;

create or replace function purezza_private.production_board(page_size int, page_offset int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  report jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO','VENDAS') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode consultar o quadro de produção.';
  end if;
  if page_size is null or page_size not between 1 and 100 or page_offset is null or page_offset < 0 then
    raise exception using errcode = '22023', message = 'Confira a paginação.';
  end if;
  with board as (
    select batch.id,batch.sequence,batch.status,batch.version,batch.lot_code,batch.started_at,stage.started_at as stage_started_at,stage.status as stage_status,
      greatest(0,floor(extract(epoch from statement_timestamp()-stage.started_at)-coalesce(pauses.seconds,0))) as stage_net_seconds,
      case when (select purezza_private.has_role('ADMINISTRADOR','PRODUCAO')) then actor.display_name end as operator,
      exists(select from public.recall_affected_batches affected where affected.batch_id=batch.id and affected.resume_authorized_at is null) as recalled,
      output_lot.internal_code as output_code,plan.production_number,plan.batches_count,demand.order_number,demand.customer_name,demand.description,demand.delivery_date
    from public.production_batches batch
    join public.production_orders plan on plan.id=batch.production_order_id
    join public.production_demands demand on demand.order_item_id=plan.demand_id
    left join public.production_batch_stages stage on stage.batch_id=batch.id and stage.status in ('EM_EXECUCAO','PAUSADA')
    left join lateral (
      select sum(greatest(0,extract(epoch from coalesce(entry.resumed_at,statement_timestamp())-entry.paused_at))) as seconds
      from public.production_stage_pauses entry where entry.batch_id=stage.batch_id and entry.stage=stage.stage
    ) pauses on stage.batch_id is not null
    left join public.profiles actor on actor.id=stage.started_by
    left join public.batch_finished_outputs output on output.batch_id=batch.id
    left join public.inventory_lots output_lot on output_lot.id=output.output_lot_id
  ), page as (
    select * from board order by delivery_date,production_number,sequence limit page_size offset page_offset
  )
  select jsonb_build_object('total',(select count(*) from board),
    'rows',coalesce((select jsonb_agg(to_jsonb(page) order by delivery_date,production_number,sequence) from page),'[]'::jsonb))
    into report;
  return report;
end
$$;
