alter table public.production_orders drop constraint production_orders_status_check;
alter table public.production_orders add constraint production_orders_status_check
  check (status in ('PLANEJADA','EM_PRODUCAO'));

alter table public.production_batches drop constraint production_batches_status_check;
alter table public.production_batches add constraint production_batches_status_check
  check (status in ('PLANEJADA','EM_PREPARACAO'));
alter table public.production_batches
  add column version int not null default 1 check (version > 0),
  add column lot_code text unique check (lot_code ~ '^SP-[0-9]{8}-[0-9]{4}$'),
  add column started_by uuid references public.profiles,
  add column started_at timestamptz,
  add constraint production_batch_start_metadata_check check (
    (status = 'PLANEJADA' and num_nonnulls(lot_code,started_by,started_at) = 0)
    or (status = 'EM_PREPARACAO' and num_nonnulls(lot_code,started_by,started_at) = 3)
  );

create table purezza_private.production_daily_counters (
  work_date date primary key,
  last_number int not null check (last_number between 1 and 9999)
);
revoke all on purezza_private.production_daily_counters from public, anon, authenticated;

create table public.production_batch_stages (
  batch_id uuid not null references public.production_batches,
  stage text not null check (stage in ('PREPARACAO','BATER_MASSA','CILINDROS','EMBALAGEM')),
  status text not null check (status = 'EM_EXECUCAO'),
  started_by uuid not null references public.profiles,
  started_at timestamptz not null,
  primary key (batch_id,stage)
);
alter table public.production_batch_stages enable row level security;
revoke all on public.production_batch_stages from public, anon, authenticated;
grant select on public.production_batch_stages to authenticated;
create policy production_batch_stages_technical_read on public.production_batch_stages for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR','PRODUCAO')));

create function purezza_private.start_batch(target_batch uuid, expected_version int, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  plan public.production_orders%rowtype;
  batch public.production_batches%rowtype;
  work_date date;
  started_time timestamptz;
  serial_number int;
  assigned_code text;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode iniciar massadas.';
  end if;
  previous := purezza_private.claim_operation('INICIAR_MASSADA',request_id,
    jsonb_build_array(target_batch,expected_version));
  if previous is not null then return previous; end if;

  select * into plan from public.production_orders where id = (
    select production_order_id from public.production_batches where id = target_batch
  ) for update;
  if not found or not exists(select from public.recipe_approvals where recipe_version_id = plan.recipe_version_id)
    or nullif(btrim(plan.recipe_snapshot->>'water_control_reference'),'') is null then
    raise exception using errcode = '22023', message = 'A ordem precisa ter uma ficha técnica aprovada e controle da água.';
  end if;
  select * into strict batch from public.production_batches where id = target_batch for update;
  if batch.version is distinct from expected_version or batch.status <> 'PLANEJADA' then
    raise exception using errcode = '40001', message = 'A massada mudou ou já foi iniciada.';
  end if;

  if jsonb_typeof(plan.recipe_snapshot->'ingredients') is distinct from 'array'
    or jsonb_array_length(plan.recipe_snapshot->'ingredients') = 0
    or exists (
      with materials as (
        select (entry->>'item_id')::uuid id,entry->>'base_unit' base_unit,
          sum((entry->>'quantity')::numeric * case
            when entry->>'unit' = entry->>'base_unit' then 1
            when (entry->>'unit',entry->>'base_unit') in (('g','kg'),('mL','L')) then 0.001
            when (entry->>'unit',entry->>'base_unit') in (('kg','g'),('L','mL')) then 1000
          end) as required_amount
        from jsonb_array_elements(plan.recipe_snapshot->'ingredients') as source(entry)
        where lower(btrim(entry->>'name')) not in ('água','agua')
        group by (entry->>'item_id')::uuid,entry->>'base_unit'
      )
      select from materials material
      left join public.items item on item.id = material.id
      where material.id is null or material.required_amount is null or item.active is distinct from true
        or item.base_unit is distinct from material.base_unit or material.required_amount > coalesce((
          select sum(suggested_quantity) from public.suggest_fefo_lots(material.id,material.required_amount)
        ),0)
    ) then
    raise exception using errcode = '22023', message = 'A massada exige saldo elegível para os insumos da ficha aprovada.';
  end if;

  started_time := clock_timestamp();
  work_date := (started_time at time zone 'America/Sao_Paulo')::date;
  if work_date <> (statement_timestamp() at time zone 'America/Sao_Paulo')::date then
    raise exception using errcode = '40001', message = 'O dia mudou durante a conferência. Repita o início da massada.';
  end if;
  insert into purezza_private.production_daily_counters as counter(work_date,last_number) values(work_date,1)
    on conflict on constraint production_daily_counters_pkey do update set last_number=counter.last_number+1
    where counter.last_number < 9999 returning last_number into serial_number;
  if serial_number is null then
    raise exception using errcode = '22023', message = 'A numeração diária de lotes foi esgotada.';
  end if;
  assigned_code := 'SP-' || to_char(work_date,'YYYYMMDD') || '-' || lpad(serial_number::text,4,'0');

  update public.production_batches set status='EM_PREPARACAO',version=version+1,
    lot_code=assigned_code,started_by=auth.uid(),started_at=started_time where id=target_batch;
  insert into public.production_batch_stages(batch_id,stage,status,started_by,started_at)
    values(target_batch,'PREPARACAO','EM_EXECUCAO',auth.uid(),started_time);
  update public.production_orders set status='EM_PRODUCAO' where id=plan.id and status='PLANEJADA';
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'INICIAR_MASSADA',
    jsonb_build_object('ordem_producao_id',plan.id,'massada_id',target_batch,'lote',assigned_code));
  update public.operation_requests set result=target_batch
    where actor=auth.uid() and operation='INICIAR_MASSADA' and operation_requests.request_id=start_batch.request_id;
  return target_batch;
end
$$;

create function public.start_batch(target_batch uuid, expected_version int, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.start_batch(target_batch,expected_version,request_id)
$$;

create function purezza_private.production_board(page_size int, page_offset int)
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
    select batch.id,batch.sequence,batch.status,batch.version,batch.lot_code,batch.started_at,
      case when (select purezza_private.has_role('ADMINISTRADOR','PRODUCAO')) then actor.display_name end as operator,
      plan.production_number,plan.batches_count,demand.order_number,demand.customer_name,demand.description,demand.delivery_date
    from public.production_batches batch
    join public.production_orders plan on plan.id=batch.production_order_id
    join public.production_demands demand on demand.order_item_id=plan.demand_id
    left join public.profiles actor on actor.id=batch.started_by
  ), page as (
    select * from board order by delivery_date,production_number,sequence limit page_size offset page_offset
  )
  select jsonb_build_object('total',(select count(*) from board),
    'rows',coalesce((select jsonb_agg(to_jsonb(page) order by delivery_date,production_number,sequence) from page),'[]'::jsonb))
    into report;
  return report;
end
$$;

create function public.production_board(page_size int, page_offset int)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.production_board(page_size,page_offset)
$$;
revoke all on function purezza_private.start_batch(uuid,int,uuid), public.start_batch(uuid,int,uuid),
  purezza_private.production_board(int,int), public.production_board(int,int) from public, anon, authenticated;
grant execute on function purezza_private.start_batch(uuid,int,uuid), public.start_batch(uuid,int,uuid),
  purezza_private.production_board(int,int), public.production_board(int,int) to authenticated;
