alter table public.production_batches drop constraint production_batches_status_check;
alter table public.production_batches add constraint production_batches_status_check
  check (status in ('PLANEJADA','EM_PREPARACAO','EM_BATER_MASSA','EM_CILINDROS','EM_EMBALAGEM'));

alter table public.production_batch_stages add column measured_kg numeric(18,6)
  check (measured_kg > 0 and measured_kg <> 'NaN'::numeric);
alter table public.production_batch_stages add column completion_notes text check (length(completion_notes) <= 1000);
create unique index production_batch_one_running_stage_idx on public.production_batch_stages(batch_id)
  where status = 'EM_EXECUCAO';

create function purezza_private.complete_production_stage(target_batch uuid, expected_version int, current_stage text,
  measured_kg numeric, notes text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  batch public.production_batches%rowtype;
  expected_status text;
  next_stage text;
  next_status text;
  transition_time timestamptz;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode concluir etapas.';
  end if;
  if current_stage is null or current_stage not in ('BATER_MASSA','CILINDROS') then
    raise exception using errcode = '22023', message = 'Selecione uma etapa válida para conclusão.';
  end if;
  if (measured_kg is not null and (not (measured_kg > 0 and measured_kg < 1000000000000)
    or measured_kg <> round(measured_kg,6))) or length(btrim(notes)) > 1000 then
    raise exception using errcode = '22023', message = 'Confira o peso medido e as observações.';
  end if;
  previous := purezza_private.claim_operation('CONCLUIR_ETAPA_PRODUCAO',request_id,
    jsonb_build_array(target_batch,expected_version,current_stage,measured_kg,notes));
  if previous is not null then return previous; end if;

  expected_status := case current_stage when 'BATER_MASSA' then 'EM_BATER_MASSA' else 'EM_CILINDROS' end;
  next_stage := case current_stage when 'BATER_MASSA' then 'CILINDROS' else 'EMBALAGEM' end;
  next_status := case current_stage when 'BATER_MASSA' then 'EM_CILINDROS' else 'EM_EMBALAGEM' end;
  select * into batch from public.production_batches where id=target_batch for update;
  if not found or batch.status<>expected_status or batch.version is distinct from expected_version then
    raise exception using errcode = '40001', message = 'A massada mudou ou não está na etapa solicitada.';
  end if;
  if current_stage = 'BATER_MASSA' then
    if not exists(select from public.production_batch_stages where batch_id=target_batch
      and stage='BATER_MASSA' and prepared_accepted_at is not null) then
      raise exception using errcode = '22023', message = 'Confirme primeiro a incorporação dos ingredientes preparados.';
    end if;
    if exists(
      select from public.production_orders plan
      cross join lateral jsonb_array_elements(plan.recipe_snapshot->'ingredients') entries(entry)
      where plan.id=batch.production_order_id and entry->>'stage'='BATER_MASSA' and
        case when lower(btrim(entry->>'name')) in ('água','agua') then not exists(
          select from public.batch_water_records where batch_id=target_batch and stage='BATER_MASSA'
            and ingredient_id=(entry->>'source_ingredient_id')::uuid
        ) else not exists(
          select from public.batch_ingredient_consumptions where batch_id=target_batch and stage='BATER_MASSA'
            and ingredient_id=(entry->>'source_ingredient_id')::uuid
        ) end
    ) then
      raise exception using errcode = '22023', message = 'Conclua todos os apontamentos de Bater massa antes de avançar.';
    end if;
  end if;

  transition_time := clock_timestamp();
  update public.production_batch_stages set status='CONCLUIDA',finished_at=transition_time,finished_by=auth.uid(),
    measured_kg=complete_production_stage.measured_kg,completion_notes=nullif(btrim(notes),'')
    where batch_id=target_batch and stage=current_stage and status='EM_EXECUCAO';
  if not found then raise exception using errcode = '22023', message = 'A etapa precisa estar em execução.'; end if;

  insert into public.production_batch_stages(batch_id,stage,status,started_by,started_at)
    values(target_batch,next_stage,'EM_EXECUCAO',auth.uid(),transition_time);
  update public.production_batches set status=next_status,version=version+1 where id=target_batch;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'CONCLUIR_ETAPA_PRODUCAO',
    jsonb_build_object('massada_id',target_batch,'etapa',current_stage,'proxima_etapa',next_stage));
  update public.operation_requests set result=target_batch
    where actor=auth.uid() and operation='CONCLUIR_ETAPA_PRODUCAO'
      and operation_requests.request_id=complete_production_stage.request_id;
  return target_batch;
end
$$;

create function public.complete_production_stage(target_batch uuid,expected_version int,current_stage text,
  measured_kg numeric, notes text,request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.complete_production_stage(target_batch,expected_version,current_stage,measured_kg,notes,request_id)
$$;
revoke all on function purezza_private.complete_production_stage(uuid,int,text,numeric,text,uuid),
  public.complete_production_stage(uuid,int,text,numeric,text,uuid) from public, anon, authenticated;
grant execute on function purezza_private.complete_production_stage(uuid,int,text,numeric,text,uuid),
  public.complete_production_stage(uuid,int,text,numeric,text,uuid) to authenticated;

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
      plan.production_number,plan.batches_count,demand.order_number,demand.customer_name,demand.description,demand.delivery_date
    from public.production_batches batch
    join public.production_orders plan on plan.id=batch.production_order_id
    join public.production_demands demand on demand.order_item_id=plan.demand_id
    left join public.production_batch_stages stage on stage.batch_id=batch.id and stage.status='EM_EXECUCAO'
    left join public.profiles actor on actor.id=stage.started_by
  ), page as (
    select * from board order by delivery_date,production_number,sequence limit page_size offset page_offset
  )
  select jsonb_build_object('total',(select count(*) from board),
    'rows',coalesce((select jsonb_agg(to_jsonb(page) order by delivery_date,production_number,sequence) from page),'[]'::jsonb))
    into report;
  return report;
end
$$;
