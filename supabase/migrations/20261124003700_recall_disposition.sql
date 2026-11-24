alter table public.recall_cases add column closed_at timestamptz;
alter table public.recall_cases add column closed_by uuid references public.profiles;
alter table public.recall_cases add column close_reference text;
alter table public.recall_cases add constraint recall_close_metadata_check check (
  (closed_at is null and closed_by is null and close_reference is null)
  or (closed_at is not null and closed_at>=opened_at and closed_by is not null
    and length(btrim(close_reference)) between 1 and 1000 and close_reference is not null)
);
drop index public.one_recall_per_root_idx;
create unique index one_recall_per_root_idx on public.recall_cases(root_lot_id) where closed_at is null;

alter table public.recall_affected_batches add column resume_authorized_at timestamptz;
alter table public.recall_affected_batches add column resume_authorized_by uuid references public.profiles;
alter table public.recall_affected_batches add column resume_reference text;
alter table public.recall_affected_batches add constraint recall_batch_resume_metadata_check check (
  (resume_authorized_at is null and resume_authorized_by is null and resume_reference is null)
  or (resume_authorized_at is not null and resume_authorized_by is not null
    and length(btrim(resume_reference)) between 1 and 1000 and resume_reference is not null)
);

create or replace function purezza_private.prevent_recall_lot_release()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status='LIBERADO' and exists(
    select from public.recall_affected_lots affected join public.recall_cases incident on incident.id=affected.case_id
    where affected.lot_id=new.id and incident.closed_at is null
  ) then
    raise exception using errcode='22023',message='O lote está vinculado a um recolhimento ativo.';
  end if;
  return new;
end
$$;

create or replace function purezza_private.prevent_recalled_batch_progress()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists(select from public.recall_affected_batches where batch_id=new.id and resume_authorized_at is null) then
    raise exception using errcode='22023',message='A massada está vinculada a um recolhimento sem autorização de retomada.';
  end if;
  return new;
end
$$;

create function purezza_private.require_recall_authority()
returns void language plpgsql set search_path = '' as $$
begin
  perform id from public.profiles where id=auth.uid() and active and role='ADMINISTRADOR' and can_release_lot for share;
  if not found then raise exception using errcode='42501',message='A decisão exige autorização sanitária específica.'; end if;
end
$$;
revoke all on function purezza_private.require_recall_authority() from public,anon,authenticated;

create function purezza_private.close_lot_recall(target_case uuid, evaluation text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare previous uuid;
begin
  perform purezza_private.require_recall_authority();
  if nullif(btrim(evaluation),'') is null or length(btrim(evaluation))>1000 then
    raise exception using errcode='22023',message='Registre a conclusão ou referência da avaliação sanitária.';
  end if;
  perform purezza_private.lock_lot_genealogy();
  previous := purezza_private.claim_operation('ENCERRAR_RECOLHIMENTO',request_id,jsonb_build_array(target_case,evaluation));
  if previous is not null then return previous; end if;

  update public.recall_cases set closed_at=clock_timestamp(),closed_by=auth.uid(),close_reference=btrim(evaluation)
    where id=target_case and closed_at is null;
  if not found then raise exception using errcode='22023',message='Selecione um recolhimento ativo.'; end if;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'ENCERRAR_RECOLHIMENTO',
    jsonb_build_object('recolhimento_id',target_case));
  update public.operation_requests set result=target_case
    where actor=auth.uid() and operation='ENCERRAR_RECOLHIMENTO'
      and operation_requests.request_id=close_lot_recall.request_id;
  return target_case;
end
$$;

create function purezza_private.authorize_recall_batch_resume(target_case uuid,target_batch uuid,evaluation text,request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare previous uuid;
begin
  perform purezza_private.require_recall_authority();
  if nullif(btrim(evaluation),'') is null or length(btrim(evaluation))>1000 then
    raise exception using errcode='22023',message='Informe a avaliação sanitária que autoriza a retomada.';
  end if;
  perform purezza_private.lock_lot_genealogy();
  previous := purezza_private.claim_operation('AUTORIZAR_RETOMADA_RECOLHIMENTO',request_id,
    jsonb_build_array(target_case,target_batch,evaluation));
  if previous is not null then return previous; end if;

  if not exists(select from public.recall_cases where id=target_case and closed_at is not null)
    or exists(select from public.recall_affected_batches affected join public.recall_cases incident on incident.id=affected.case_id
      where affected.batch_id=target_batch and incident.closed_at is null) then
    raise exception using errcode='22023',message='Encerre todos os casos ativos que afetam esta massada antes de autorizar a retomada.';
  end if;
  perform id from public.production_batches where id=target_batch
    and status not in ('PLANEJADA','FINALIZADA') for update;
  if not found then raise exception using errcode='22023',message='Selecione uma massada em andamento.'; end if;

  update public.recall_affected_batches set resume_authorized_at=clock_timestamp(),resume_authorized_by=auth.uid(),
    resume_reference=btrim(evaluation)
    where case_id=target_case and batch_id=target_batch and resume_authorized_at is null;
  if not found then raise exception using errcode='22023',message='Selecione uma massada afetada com retomada pendente neste caso.'; end if;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'AUTORIZAR_RETOMADA_RECOLHIMENTO',
    jsonb_build_object('recolhimento_id',target_case,'massada_id',target_batch));
  update public.operation_requests set result=target_batch
    where actor=auth.uid() and operation='AUTORIZAR_RETOMADA_RECOLHIMENTO'
      and operation_requests.request_id=authorize_recall_batch_resume.request_id;
  return target_batch;
end
$$;

create function public.close_lot_recall(target_case uuid,evaluation text,request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.close_lot_recall(target_case,evaluation,request_id)
$$;
create function public.authorize_recall_batch_resume(target_case uuid,target_batch uuid,evaluation text,request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.authorize_recall_batch_resume(target_case,target_batch,evaluation,request_id)
$$;
revoke all on function purezza_private.close_lot_recall(uuid,text,uuid),public.close_lot_recall(uuid,text,uuid),
  purezza_private.authorize_recall_batch_resume(uuid,uuid,text,uuid),public.authorize_recall_batch_resume(uuid,uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function purezza_private.close_lot_recall(uuid,text,uuid),public.close_lot_recall(uuid,text,uuid),
  purezza_private.authorize_recall_batch_resume(uuid,uuid,text,uuid),public.authorize_recall_batch_resume(uuid,uuid,text,uuid)
  to authenticated;

create or replace function purezza_private.open_lot_recall(target_code text, reason text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  source_id uuid;
  affected_ids uuid[];
  batch_ids uuid[];
  current_lot record;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode='42501',message='Somente Administração pode abrir um recolhimento.';
  end if;
  if target_code is null or target_code !~ '^REC-[a-f0-9]{32}$'
    or nullif(btrim(reason),'') is null or length(btrim(reason))>1000 then
    raise exception using errcode='22023',message='Informe o lote de origem e o motivo do recolhimento.';
  end if;

  perform purezza_private.lock_lot_genealogy();
  result_id := purezza_private.claim_operation('ABRIR_RECOLHIMENTO',request_id,jsonb_build_array(target_code,reason));
  if result_id is not null then return result_id; end if;
  select id into source_id from public.inventory_lots where internal_code=target_code;
  if not found then raise exception using errcode='22023',message='Lote de origem não encontrado.'; end if;

  with recursive affected(id) as (
    select source_id
    union
    select child.id from affected parent cross join lateral (
      select returned.return_lot_id as id
      from public.stock_reservations reservation
      join public.shipments shipment on shipment.reservation_id=reservation.id
      join public.shipment_returns returned on returned.shipment_id=shipment.id
      where reservation.lot_id=parent.id
      union
      select output.output_lot_id
      from public.batch_ingredient_consumption_lots usage
      join public.batch_ingredient_consumptions consumption on consumption.id=usage.consumption_id
      join public.batch_finished_outputs output on output.batch_id=consumption.batch_id
      where usage.lot_id=parent.id
      union
      select output.output_lot_id
      from public.batch_packaging_consumptions usage
      join public.batch_finished_outputs output on output.batch_id=usage.batch_id
      where usage.lot_id=parent.id
    ) child
  )
  select array_agg(id order by id) into affected_ids from affected;

  insert into public.recall_cases(root_lot_id,reason,opened_by)
    values(source_id,open_lot_recall.reason,auth.uid())
    on conflict(root_lot_id) where closed_at is null do nothing returning id into result_id;
  if result_id is null then raise exception using errcode='23505',message='Já existe um recolhimento para este lote de origem.'; end if;

  for current_lot in select id,status from public.inventory_lots where id=any(affected_ids) order by id for update loop
    insert into public.recall_affected_lots(case_id,lot_id,prior_status) values(result_id,current_lot.id,current_lot.status);
    if current_lot.status not in ('BLOQUEADO','REPROVADO') then
      update public.inventory_lots set status='BLOQUEADO',version=version+1 where id=current_lot.id;
      insert into public.lot_releases(lot_id,old_status,new_status,reason,actor)
        values(current_lot.id,current_lot.status,'BLOQUEADO','Recolhimento ' || result_id::text,auth.uid());
    end if;
  end loop;

  select array_agg(affected_batch.batch_id order by affected_batch.batch_id) into batch_ids from (
      select consumption.batch_id from public.batch_ingredient_consumption_lots usage
      join public.batch_ingredient_consumptions consumption on consumption.id=usage.consumption_id
      where usage.lot_id=any(affected_ids)
      union
      select batch_id from public.batch_packaging_consumptions where lot_id=any(affected_ids)
      union
      select production_batch_id from public.inventory_lots where id=any(affected_ids) and production_batch_id is not null
  ) affected_batch;
  perform id from public.production_batches where id=any(batch_ids) order by id for update;
  insert into public.recall_affected_batches(case_id,batch_id)
    select result_id,id from unnest(batch_ids) batch(id);

  insert into public.audit_logs(actor,action,details) values(auth.uid(),'ABRIR_RECOLHIMENTO',
    jsonb_build_object('recolhimento_id',result_id,'lote_origem_id',source_id,'lotes',cardinality(affected_ids)));
  update public.operation_requests set result=result_id where actor=auth.uid() and operation='ABRIR_RECOLHIMENTO'
    and operation_requests.request_id=open_lot_recall.request_id;
  return result_id;
end
$$;

create or replace function purezza_private.lot_recall_details(target_case uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode='42501',message='Seu perfil não pode consultar recolhimentos.';
  end if;

  select jsonb_build_object(
    'id',incident.id,'case_number',incident.case_number,'reason',incident.reason,'opened_at',incident.opened_at,
    'root_code',root_lot.internal_code,'closed_at',incident.closed_at,
    'close_reference',incident.close_reference,'closed_by',closer.display_name,
    'lots',coalesce((
      select jsonb_agg(jsonb_build_object('code',lot.internal_code,'status',lot.status,'prior_status',affected.prior_status,
        'physical',coalesce((select sum(quantity) from public.stock_balances where lot_id=lot.id),0)::text,
        'unit',lot.unit) order by lot.internal_code)
      from public.recall_affected_lots affected join public.inventory_lots lot on lot.id=affected.lot_id
      where affected.case_id=incident.id
    ),'[]'::jsonb),
    'batches',coalesce((
      select jsonb_agg(jsonb_build_object('id',batch.id,'code',batch.lot_code,'status',batch.status,
        'resume_authorized_at',affected.resume_authorized_at,'resume_reference',affected.resume_reference)
        order by batch.lot_code)
      from public.recall_affected_batches affected join public.production_batches batch on batch.id=affected.batch_id
      where affected.case_id=incident.id
    ),'[]'::jsonb),
    'shipments',coalesce((
      select jsonb_agg(jsonb_build_object('id',shipment.id,'code',lot.internal_code,'order_number',purchase.order_number,
        'customer',purchase.customer_name,'quantity',shipment.quantity::text,'unit',lot.unit,
        'dispatched_at',shipment.dispatched_at) order by shipment.dispatched_at,shipment.id)
      from public.recall_affected_lots affected join public.inventory_lots lot on lot.id=affected.lot_id
      join public.stock_reservations reservation on reservation.lot_id=lot.id
      join public.shipments shipment on shipment.reservation_id=reservation.id
      join public.orders purchase on purchase.id=shipment.order_id
      where affected.case_id=incident.id
    ),'[]'::jsonb),
    'actions',coalesce((
      select jsonb_agg(jsonb_build_object('id',action.id,'note',action.action_note,'shipment_id',action.shipment_id,
        'recorded_at',action.recorded_at,'operator',actor.display_name) order by action.recorded_at,action.id)
      from public.recall_actions action join public.profiles actor on actor.id=action.actor where action.case_id=incident.id
    ),'[]'::jsonb)
  ) into result from public.recall_cases incident join public.inventory_lots root_lot on root_lot.id=incident.root_lot_id
  left join public.profiles closer on closer.id=incident.closed_by
  where incident.id=target_case;
  return result;
end
$$;

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
    select batch.id,batch.sequence,batch.status,batch.version,batch.lot_code,batch.started_at,stage.started_at as stage_started_at,
      case when (select purezza_private.has_role('ADMINISTRADOR','PRODUCAO')) then actor.display_name end as operator,
      exists(select from public.recall_affected_batches affected where affected.batch_id=batch.id and affected.resume_authorized_at is null) as recalled,
      output_lot.internal_code as output_code,plan.production_number,plan.batches_count,demand.order_number,demand.customer_name,demand.description,demand.delivery_date
    from public.production_batches batch
    join public.production_orders plan on plan.id=batch.production_order_id
    join public.production_demands demand on demand.order_item_id=plan.demand_id
    left join public.production_batch_stages stage on stage.batch_id=batch.id and stage.status='EM_EXECUCAO'
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
