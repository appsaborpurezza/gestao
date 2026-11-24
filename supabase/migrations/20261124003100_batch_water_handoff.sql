alter table public.production_batches drop constraint production_batches_status_check;
alter table public.production_batches drop constraint production_batch_start_metadata_check;
alter table public.production_batches add constraint production_batches_status_check
  check (status in ('PLANEJADA','EM_PREPARACAO','EM_BATER_MASSA'));
alter table public.production_batches add constraint production_batch_start_metadata_check check (
  (status = 'PLANEJADA' and num_nonnulls(lot_code,started_by,started_at) = 0)
  or (status <> 'PLANEJADA' and num_nonnulls(lot_code,started_by,started_at) = 3)
);

alter table public.production_batch_stages drop constraint production_batch_stages_status_check;
alter table public.production_batch_stages add column finished_at timestamptz;
alter table public.production_batch_stages add column finished_by uuid references public.profiles;
alter table public.production_batch_stages add column prepared_accepted_at timestamptz;
alter table public.production_batch_stages add column prepared_accepted_by uuid references public.profiles;
alter table public.production_batch_stages add constraint stage_status_metadata_check check (
  (status = 'EM_EXECUCAO' and finished_at is null and finished_by is null)
  or (status = 'CONCLUIDA' and finished_at is not null and finished_by is not null and finished_at >= started_at)
);
alter table public.production_batch_stages add constraint stage_handoff_metadata_check check (
  (prepared_accepted_at is null and prepared_accepted_by is null)
  or (stage = 'BATER_MASSA' and prepared_accepted_at is not null and prepared_accepted_by is not null
    and prepared_accepted_at >= started_at)
);

alter table public.stock_movements drop constraint stock_movements_kind_check;
alter table public.stock_movements add constraint stock_movements_kind_check
  check (kind in ('RECEBIMENTO','TRANSFERENCIA','AJUSTE_INVENTARIO','ABERTURA_INVENTARIO','EXPEDICAO',
    'DEVOLUCAO_EXPEDICAO','CONSUMO_PREPARACAO','CONSUMO_BATER_MASSA'));
alter table public.batch_ingredient_consumptions add column stage text not null default 'PREPARACAO'
  check (stage in ('PREPARACAO','BATER_MASSA'));

create table public.batch_water_records (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.production_batches,
  ingredient_id uuid not null references public.recipe_ingredients,
  stage text not null check (stage in ('PREPARACAO','BATER_MASSA')),
  quantity numeric(18,6) not null check (quantity > 0 and quantity <> 'NaN'::numeric),
  unit text not null check (unit in ('kg','g','L','mL','un')),
  source text not null check (length(btrim(source)) between 1 and 300),
  control_reference text not null check (length(btrim(control_reference)) between 1 and 500),
  recorded_by uuid not null references public.profiles,
  recorded_at timestamptz not null default statement_timestamp(),
  unique(batch_id,ingredient_id)
);
alter table public.batch_water_records enable row level security;
revoke all on public.batch_water_records from public, anon, authenticated;
grant select on public.batch_water_records to authenticated;
create policy batch_water_technical_read on public.batch_water_records for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR','PRODUCAO')));

create function purezza_private.record_batch_water(
  target_batch uuid, target_ingredient uuid, expected_version int, amount numeric,
  source text, control_reference text, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  batch public.production_batches%rowtype;
  line jsonb;
  expected numeric;
  current_stage text;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode registrar água de processo.';
  end if;
  result_id := purezza_private.claim_operation('REGISTRAR_AGUA_MASSADA',request_id,
    jsonb_build_array(target_batch,target_ingredient,expected_version,amount,source,control_reference));
  if result_id is not null then return result_id; end if;

  select * into batch from public.production_batches where id=target_batch for update;
  if not found or batch.version is distinct from expected_version
    or batch.status not in ('EM_PREPARACAO','EM_BATER_MASSA') then
    raise exception using errcode = '40001', message = 'A massada mudou. Atualize a ficha.';
  end if;
  current_stage := case batch.status when 'EM_PREPARACAO' then 'PREPARACAO' else 'BATER_MASSA' end;
  select entry into line from public.production_orders plan
    cross join lateral jsonb_array_elements(plan.recipe_snapshot->'ingredients') entries(entry)
    where plan.id=batch.production_order_id and entry->>'source_ingredient_id'=target_ingredient::text
      and entry->>'stage'=current_stage and lower(btrim(entry->>'name')) in ('água','agua');
  if line is null then
    raise exception using errcode = '22023', message = 'A ficha não prevê este registro de água na etapa atual.';
  end if;
  expected := (line->>'quantity')::numeric;
  if amount is null or not (amount > 0 and amount < 1000000000000) or amount <> round(amount,6)
    or (line->>'unit'='un' and amount<>trunc(amount))
    or amount < expected - (line->>'lower_tolerance')::numeric or amount > expected + (line->>'upper_tolerance')::numeric
    or nullif(btrim(source),'') is null or length(btrim(source))>300
    or nullif(btrim(control_reference),'') is null or length(btrim(control_reference))>500 then
    raise exception using errcode = '22023', message = 'Confira a quantidade aprovada, a origem e o controle da água.';
  end if;

  insert into public.batch_water_records(batch_id,ingredient_id,stage,quantity,unit,source,control_reference,recorded_by)
    values(target_batch,target_ingredient,current_stage,amount,line->>'unit',btrim(source),btrim(control_reference),auth.uid())
    on conflict(batch_id,ingredient_id) do nothing returning id into result_id;
  if result_id is null then raise exception using errcode = '23505', message = 'A água desta linha já foi registrada.'; end if;
  update public.production_batches set version=version+1 where id=target_batch;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'REGISTRAR_AGUA_MASSADA',
    jsonb_build_object('massada_id',target_batch,'apontamento_id',result_id));
  update public.operation_requests set result=result_id
    where actor=auth.uid() and operation='REGISTRAR_AGUA_MASSADA' and operation_requests.request_id=record_batch_water.request_id;
  return result_id;
end
$$;

create function purezza_private.complete_preparation(target_batch uuid, expected_version int, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  batch public.production_batches%rowtype;
  transition_time timestamptz;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode avançar massadas.';
  end if;
  previous := purezza_private.claim_operation('CONCLUIR_PREPARACAO',request_id,jsonb_build_array(target_batch,expected_version));
  if previous is not null then return previous; end if;

  select * into batch from public.production_batches where id=target_batch for update;
  if not found or batch.status <> 'EM_PREPARACAO' or batch.version is distinct from expected_version then
    raise exception using errcode = '40001', message = 'A preparação mudou. Atualize a ficha.';
  end if;
  if exists(
    select from public.production_orders plan
    cross join lateral jsonb_array_elements(plan.recipe_snapshot->'ingredients') entries(entry)
    where plan.id=batch.production_order_id and entry->>'stage'='PREPARACAO' and
      case when lower(btrim(entry->>'name')) in ('água','agua') then not exists(
        select from public.batch_water_records where batch_id=target_batch and ingredient_id=(entry->>'source_ingredient_id')::uuid
      ) else not exists(
        select from public.batch_ingredient_consumptions where batch_id=target_batch and ingredient_id=(entry->>'source_ingredient_id')::uuid
      ) end
  ) then
    raise exception using errcode = '22023', message = 'Conclua todos os apontamentos da preparação antes de avançar.';
  end if;

  transition_time := clock_timestamp();
  update public.production_batch_stages set status='CONCLUIDA',finished_at=transition_time,finished_by=auth.uid()
    where batch_id=target_batch and stage='PREPARACAO' and status='EM_EXECUCAO';
  if not found then raise exception using errcode = '22023', message = 'A preparação precisa estar em execução.'; end if;
  insert into public.production_batch_stages(batch_id,stage,status,started_by,started_at)
    values(target_batch,'BATER_MASSA','EM_EXECUCAO',auth.uid(),transition_time);
  update public.production_batches set status='EM_BATER_MASSA',version=version+1 where id=target_batch;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'CONCLUIR_PREPARACAO',jsonb_build_object('massada_id',target_batch));
  update public.operation_requests set result=target_batch
    where actor=auth.uid() and operation='CONCLUIR_PREPARACAO' and operation_requests.request_id=complete_preparation.request_id;
  return target_batch;
end
$$;

create function purezza_private.confirm_prepared_ingredients(target_batch uuid, expected_version int, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  batch public.production_batches%rowtype;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode confirmar a incorporação.';
  end if;
  previous := purezza_private.claim_operation('CONFIRMAR_INCORPORACAO',request_id,jsonb_build_array(target_batch,expected_version));
  if previous is not null then return previous; end if;

  select * into batch from public.production_batches where id=target_batch for update;
  if not found or batch.status <> 'EM_BATER_MASSA' or batch.version is distinct from expected_version then
    raise exception using errcode = '40001', message = 'A massada mudou ou não está em Bater massa.';
  end if;
  update public.production_batch_stages set prepared_accepted_at=clock_timestamp(),prepared_accepted_by=auth.uid()
    where batch_id=target_batch and stage='BATER_MASSA' and status='EM_EXECUCAO' and prepared_accepted_at is null;
  if not found then raise exception using errcode = '22023', message = 'A incorporação já foi confirmada ou a etapa está fechada.'; end if;
  update public.production_batches set version=version+1 where id=target_batch;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'CONFIRMAR_INCORPORACAO',jsonb_build_object('massada_id',target_batch));
  update public.operation_requests set result=target_batch
    where actor=auth.uid() and operation='CONFIRMAR_INCORPORACAO' and operation_requests.request_id=confirm_prepared_ingredients.request_id;
  return target_batch;
end
$$;

create function public.record_batch_water(target_batch uuid, target_ingredient uuid, expected_version int, amount numeric,
  source text, control_reference text, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.record_batch_water(target_batch,target_ingredient,expected_version,amount,source,control_reference,request_id)
$$;
create function public.complete_preparation(target_batch uuid, expected_version int, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.complete_preparation(target_batch,expected_version,request_id)
$$;
create function public.confirm_prepared_ingredients(target_batch uuid, expected_version int, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.confirm_prepared_ingredients(target_batch,expected_version,request_id)
$$;

create function public.production_stage_checklist(target_batch uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode consultar a ficha da massada.';
  end if;
  select jsonb_build_object(
    'version',batch.version,'stage',stage.stage,'prepared_accepted_at',stage.prepared_accepted_at,
    'items',coalesce((
      select jsonb_agg(entry || jsonb_build_object('consumed',coalesce(consumption.quantity,water.quantity)::text,
        'water_source',water.source,'water_reference',water.control_reference) order by position)
      from jsonb_array_elements(plan.recipe_snapshot->'ingredients') with ordinality source(entry,position)
      left join public.batch_ingredient_consumptions consumption
        on consumption.batch_id=batch.id and consumption.ingredient_id=(entry->>'source_ingredient_id')::uuid
      left join public.batch_water_records water
        on water.batch_id=batch.id and water.ingredient_id=(entry->>'source_ingredient_id')::uuid
      where entry->>'stage'=stage.stage
    ),'[]'::jsonb),
    'prepared_lots',coalesce((
      select jsonb_agg(jsonb_build_object('name',ingredient.source_name,'code',lot.internal_code,
        'location',location.code,'quantity',position.quantity::text,'unit',lot.unit)
        order by ingredient.ordinal,lot.internal_code,location.code)
      from public.batch_ingredient_consumptions consumption
      join public.recipe_ingredients ingredient on ingredient.id=consumption.ingredient_id
      join public.batch_ingredient_consumption_lots position on position.consumption_id=consumption.id
      join public.inventory_lots lot on lot.id=position.lot_id
      join public.locations location on location.id=position.location_id
      where stage.stage='BATER_MASSA' and consumption.batch_id=batch.id and consumption.stage='PREPARACAO'
    ),'[]'::jsonb),
    'prepared_water',coalesce((
      select jsonb_agg(jsonb_build_object('source',water.source,'reference',water.control_reference,
        'quantity',water.quantity::text,'unit',water.unit) order by water.recorded_at,water.id)
      from public.batch_water_records water
      where stage.stage='BATER_MASSA' and water.batch_id=batch.id and water.stage='PREPARACAO'
    ),'[]'::jsonb)
  ) into result
  from public.production_batches batch
  join public.production_orders plan on plan.id=batch.production_order_id
  join public.production_batch_stages stage on stage.batch_id=batch.id and stage.status='EM_EXECUCAO'
    and stage.stage=case batch.status when 'EM_PREPARACAO' then 'PREPARACAO' when 'EM_BATER_MASSA' then 'BATER_MASSA' end
  where batch.id=target_batch;
  return result;
end
$$;

revoke all on function purezza_private.record_batch_water(uuid,uuid,int,numeric,text,text,uuid),
  public.record_batch_water(uuid,uuid,int,numeric,text,text,uuid),
  purezza_private.complete_preparation(uuid,int,uuid),public.complete_preparation(uuid,int,uuid),
  purezza_private.confirm_prepared_ingredients(uuid,int,uuid),public.confirm_prepared_ingredients(uuid,int,uuid),
  public.production_stage_checklist(uuid) from public, anon, authenticated;
grant execute on function purezza_private.record_batch_water(uuid,uuid,int,numeric,text,text,uuid),
  public.record_batch_water(uuid,uuid,int,numeric,text,text,uuid),
  purezza_private.complete_preparation(uuid,int,uuid),public.complete_preparation(uuid,int,uuid),
  purezza_private.confirm_prepared_ingredients(uuid,int,uuid),public.confirm_prepared_ingredients(uuid,int,uuid),
  public.production_stage_checklist(uuid) to authenticated;

create or replace function purezza_private.preparation_item(target_batch uuid, target_ingredient uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select entry
  from public.production_batches batch
  join public.production_orders plan on plan.id = batch.production_order_id
  cross join lateral jsonb_array_elements(plan.recipe_snapshot->'ingredients') source(entry)
  where batch.id = target_batch and batch.status in ('EM_PREPARACAO','EM_BATER_MASSA')
    and entry->>'stage' = case batch.status when 'EM_PREPARACAO' then 'PREPARACAO' else 'BATER_MASSA' end and entry->>'source_ingredient_id' = target_ingredient::text
    and lower(btrim(entry->>'name')) not in ('água','agua')
$$;

create or replace function purezza_private.confirm_preparation_ingredient(
  target_batch uuid, target_ingredient uuid, expected_version int, amount numeric,
  expected_allocations jsonb, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  consumption uuid := gen_random_uuid();
  batch public.production_batches%rowtype;
  ingredient jsonb;
  stock_item uuid;
  base_amount numeric;
  locked_lots uuid[];
  preview jsonb;
  allocation jsonb;
  target_lot uuid;
  target_location uuid;
  debit numeric;
  movement uuid;
  current_stage text;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode confirmar pesagens.';
  end if;
  previous := purezza_private.claim_operation('PESAR_INGREDIENTE',request_id,
    jsonb_build_array(target_batch,target_ingredient,expected_version,amount,expected_allocations));
  if previous is not null then return previous; end if;

  select * into batch from public.production_batches where id = target_batch for update;
  if not found or batch.status not in ('EM_PREPARACAO','EM_BATER_MASSA') or batch.version is distinct from expected_version then
    raise exception using errcode = '40001', message = 'A massada mudou. Atualize a ficha antes de confirmar.';
  end if;
  if exists(select from public.batch_ingredient_consumptions where batch_id=target_batch and ingredient_id=target_ingredient) then
    raise exception using errcode = '23505', message = 'Este ingrediente já foi apontado na massada.';
  end if;

  ingredient := purezza_private.preparation_item(target_batch,target_ingredient);
  base_amount := purezza_private.preparation_amount(ingredient,amount);
  stock_item := (ingredient->>'item_id')::uuid;
  current_stage := ingredient->>'stage';
  perform id from public.items where id=stock_item and active and base_unit=ingredient->>'base_unit' for update;
  if not found then raise exception using errcode = '22023', message = 'O insumo está inativo ou sua unidade mudou.'; end if;
  select array(select id from public.inventory_lots where item_id=stock_item order by id for update) into locked_lots;

  preview := purezza_private.preparation_allocations(stock_item,base_amount);
  if expected_allocations is distinct from preview then
    raise exception using errcode = '40001', message = 'Os lotes FEFO mudaram. Confira a sugestão atual antes de confirmar.';
  end if;

  insert into public.batch_ingredient_consumptions(id,batch_id,ingredient_id,item_id,quantity,unit,actor,stage)
    values(consumption,target_batch,target_ingredient,stock_item,amount,ingredient->>'unit',auth.uid(),current_stage);
  for allocation in select value from jsonb_array_elements(preview) loop
    target_lot := (allocation->>'lot_id')::uuid;
    target_location := (allocation->>'location_id')::uuid;
    debit := (allocation->>'quantity')::numeric;
    if not (target_lot = any(locked_lots)) then
      raise exception using errcode = '40001', message = 'Os lotes mudaram durante a conferência.';
    end if;
    perform id from public.locations where id=target_location and active for share;
    if not found then raise exception using errcode = '22023', message = 'O local do lote ficou inativo.'; end if;
    perform id from public.inventory_lots where id=target_lot and status='LIBERADO'
      and (expiry='NAO_APLICAVEL' or (expiry='INFORMADA' and expires_on >
        (clock_timestamp() at time zone 'America/Sao_Paulo')::date));
    if not found then raise exception using errcode = '22023', message = 'O lote não está mais elegível para a pesagem.'; end if;
    update public.stock_balances set quantity=quantity-debit
      where lot_id=target_lot and location_id=target_location and quantity>=debit;
    if not found then raise exception using errcode = '22023', message = 'Saldo insuficiente para registrar o consumo.'; end if;
    insert into public.stock_movements(lot_id,location_id,quantity_delta,kind,actor,correlation_id)
      values(target_lot,target_location,-debit,case current_stage when 'PREPARACAO' then 'CONSUMO_PREPARACAO' else 'CONSUMO_BATER_MASSA' end,auth.uid(),consumption) returning id into movement;
    insert into public.batch_ingredient_consumption_lots(consumption_id,lot_id,location_id,quantity,movement_id)
      values(consumption,target_lot,target_location,debit,movement);
  end loop;
  update public.production_batches set version=version+1 where id=target_batch;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'PESAR_INGREDIENTE',
    jsonb_build_object('massada_id',target_batch,'consumo_id',consumption));
  update public.operation_requests set result=consumption
    where actor=auth.uid() and operation='PESAR_INGREDIENTE'
      and operation_requests.request_id=confirm_preparation_ingredient.request_id;
  return consumption;
end
$$;
