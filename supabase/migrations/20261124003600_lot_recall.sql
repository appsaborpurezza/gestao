create table public.recall_cases (
  id uuid primary key default gen_random_uuid(),
  case_number bigint generated always as identity unique,
  root_lot_id uuid not null references public.inventory_lots,
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  opened_by uuid not null references public.profiles,
  opened_at timestamptz not null default statement_timestamp()
);
create unique index one_recall_per_root_idx on public.recall_cases(root_lot_id);

create table public.recall_affected_lots (
  case_id uuid not null references public.recall_cases,
  lot_id uuid not null references public.inventory_lots,
  prior_status public.lot_status not null,
  primary key(case_id,lot_id)
);
create index recall_affected_lot_idx on public.recall_affected_lots(lot_id);

create table public.recall_affected_batches (
  case_id uuid not null references public.recall_cases,
  batch_id uuid not null references public.production_batches,
  primary key(case_id,batch_id)
);
create index recall_affected_batch_idx on public.recall_affected_batches(batch_id);

create table public.recall_actions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.recall_cases,
  shipment_id uuid references public.shipments,
  action_note text not null check (length(btrim(action_note)) between 1 and 1000),
  actor uuid not null references public.profiles,
  recorded_at timestamptz not null default statement_timestamp()
);
create index recall_actions_case_idx on public.recall_actions(case_id,recorded_at);

do $$
declare relation text;
begin
  foreach relation in array array['recall_cases','recall_affected_lots','recall_affected_batches','recall_actions'] loop
    execute format('alter table public.%I enable row level security',relation);
    execute format('revoke all on public.%I from public,anon,authenticated',relation);
    execute format('grant select on public.%I to authenticated',relation);
    execute format('create policy recall_operational_read on public.%I for select to authenticated
      using ((select purezza_private.has_role(''ADMINISTRADOR'',''PRODUCAO'')))',relation);
  end loop;
end
$$;

create function purezza_private.lock_lot_genealogy()
returns void language sql set search_path = '' as $$
  select pg_advisory_xact_lock(2051,36)
$$;
revoke all on function purezza_private.lock_lot_genealogy() from public,anon,authenticated;

create function purezza_private.prevent_recall_lot_release()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status='LIBERADO' and exists(
    select from public.recall_affected_lots where lot_id=new.id
  ) then
    raise exception using errcode='22023',message='O lote está vinculado a um recolhimento ativo.';
  end if;
  return new;
end
$$;
revoke all on function purezza_private.prevent_recall_lot_release() from public,anon,authenticated;
create trigger prevent_recall_lot_release before update of status on public.inventory_lots
  for each row execute function purezza_private.prevent_recall_lot_release();

create function purezza_private.prevent_recalled_batch_progress()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists(select from public.recall_affected_batches where batch_id=new.id) then
    raise exception using errcode='22023',message='A massada está vinculada a um recolhimento ativo.';
  end if;
  return new;
end
$$;
revoke all on function purezza_private.prevent_recalled_batch_progress() from public,anon,authenticated;
create trigger prevent_recalled_batch_progress before update on public.production_batches
  for each row execute function purezza_private.prevent_recalled_batch_progress();

create function purezza_private.open_lot_recall(target_code text, reason text, request_id uuid)
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
    on conflict(root_lot_id) do nothing returning id into result_id;
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

create function purezza_private.attach_recalled_return()
returns trigger language plpgsql set search_path = '' as $$
begin
  insert into public.recall_affected_lots(case_id,lot_id,prior_status)
    select affected.case_id,new.return_lot_id,'QUARENTENA'
    from public.shipments shipment
    join public.stock_reservations res on res.id=shipment.reservation_id
    join public.recall_affected_lots affected on affected.lot_id=res.lot_id
    where shipment.id=new.shipment_id on conflict do nothing;
  return new;
end
$$;
revoke all on function purezza_private.attach_recalled_return() from public,anon,authenticated;
create trigger attach_recalled_return after insert on public.shipment_returns
  for each row execute function purezza_private.attach_recalled_return();

create function purezza_private.record_recall_action(target_case uuid, target_shipment uuid, note text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode='42501',message='Seu perfil não pode registrar ações de recolhimento.';
  end if;
  result_id := purezza_private.claim_operation('ACAO_RECOLHIMENTO',request_id,jsonb_build_array(target_case,target_shipment,note));
  if result_id is not null then return result_id; end if;
  if nullif(btrim(note),'') is null or length(btrim(note))>1000 then
    raise exception using errcode='22023',message='Descreva a ação realizada.';
  end if;
  if not exists(select from public.recall_cases where id=target_case) or (target_shipment is not null and not exists(
    select from public.shipments shipment
    join public.stock_reservations reservation on reservation.id=shipment.reservation_id
    join public.recall_affected_lots affected on affected.lot_id=reservation.lot_id
    where shipment.id=target_shipment and affected.case_id=target_case
  )) then raise exception using errcode='22023',message='Selecione o caso e um despacho afetado válido.'; end if;
  insert into public.recall_actions(case_id,shipment_id,action_note,actor)
    values(target_case,target_shipment,btrim(note),auth.uid()) returning id into result_id;
  update public.operation_requests set result=result_id where actor=auth.uid() and operation='ACAO_RECOLHIMENTO'
    and operation_requests.request_id=record_recall_action.request_id;
  return result_id;
end
$$;

create function purezza_private.lot_recall_details(target_case uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode='42501',message='Seu perfil não pode consultar recolhimentos.';
  end if;

  select jsonb_build_object(
    'id',incident.id,'case_number',incident.case_number,'reason',incident.reason,'opened_at',incident.opened_at,
    'root_code',root_lot.internal_code,
    'lots',coalesce((
      select jsonb_agg(jsonb_build_object('code',lot.internal_code,'status',lot.status,'prior_status',affected.prior_status,
        'physical',coalesce((select sum(quantity) from public.stock_balances where lot_id=lot.id),0)::text,
        'unit',lot.unit) order by lot.internal_code)
      from public.recall_affected_lots affected join public.inventory_lots lot on lot.id=affected.lot_id
      where affected.case_id=incident.id
    ),'[]'::jsonb),
    'batches',coalesce((
      select jsonb_agg(jsonb_build_object('code',batch.lot_code,'status',batch.status)
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
  where incident.id=target_case;
  return result;
end
$$;

create function public.open_lot_recall(target_code text,reason text,request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.open_lot_recall(target_code,reason,request_id)
$$;
create function public.record_recall_action(target_case uuid,target_shipment uuid,note text,request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.record_recall_action(target_case,target_shipment,note,request_id)
$$;
create function public.lot_recall_details(target_case uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.lot_recall_details(target_case)
$$;
revoke all on function purezza_private.open_lot_recall(text,text,uuid),public.open_lot_recall(text,text,uuid),
  purezza_private.record_recall_action(uuid,uuid,text,uuid),public.record_recall_action(uuid,uuid,text,uuid),
  purezza_private.lot_recall_details(uuid),public.lot_recall_details(uuid) from public,anon,authenticated;
grant execute on function purezza_private.open_lot_recall(text,text,uuid),public.open_lot_recall(text,text,uuid),
  purezza_private.record_recall_action(uuid,uuid,text,uuid),public.record_recall_action(uuid,uuid,text,uuid),
  purezza_private.lot_recall_details(uuid),public.lot_recall_details(uuid) to authenticated;

create or replace function purezza_private.register_shipment_return(
  target_shipment uuid, target_location uuid, amount numeric, reason text, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  return_id uuid := gen_random_uuid();
  previous uuid;
  dispatch public.shipments%rowtype;
  source_lot public.inventory_lots%rowtype;
  new_lot uuid;
  movement uuid;
  returned numeric;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode registrar devoluções.';
  end if;
  perform purezza_private.lock_lot_genealogy();
  previous := purezza_private.claim_operation('REGISTRAR_DEVOLUCAO',request_id,
    jsonb_build_array(target_shipment,target_location,amount,reason));
  if previous is not null then return previous; end if;

  select * into dispatch from public.shipments where id = target_shipment for update;
  if not found then raise exception using errcode = '22023', message = 'Selecione a expedição original.'; end if;
  select * into strict source_lot from public.inventory_lots where id = (
    select lot_id from public.stock_reservations where id = dispatch.reservation_id
  );
  select coalesce(sum(quantity),0) into returned from public.shipment_returns where shipment_id = target_shipment;
  if amount is null or not (amount > 0 and amount <= dispatch.quantity - returned)
    or amount <> round(amount,6) or (source_lot.unit = 'un' and amount <> trunc(amount))
    or nullif(btrim(reason),'') is null or length(btrim(reason)) > 500 then
    raise exception using errcode = '22023', message = 'Confira a quantidade ainda devolvível e o motivo.';
  end if;
  perform id from public.locations where id = target_location and active for share;
  if not found then raise exception using errcode = '22023', message = 'Selecione um local ativo para a quarentena.'; end if;

  insert into public.inventory_lots(item_id,manufacturer_id,original_lot,manufactured_on,expires_on,
    expiry,expiry_reason,unit,return_shipment_id)
  values(source_lot.item_id,source_lot.manufacturer_id,source_lot.original_lot,source_lot.manufactured_on,
    source_lot.expires_on,source_lot.expiry,source_lot.expiry_reason,source_lot.unit,target_shipment)
  returning id into new_lot;
  insert into public.stock_balances(lot_id,location_id,quantity) values(new_lot,target_location,amount);
  insert into public.stock_movements(lot_id,location_id,quantity_delta,kind,actor,correlation_id)
    values(new_lot,target_location,amount,'DEVOLUCAO_EXPEDICAO',auth.uid(),return_id)
    returning id into movement;
  insert into public.shipment_returns(id,shipment_id,return_lot_id,stock_movement_id,quantity,reason,registered_by)
    values(return_id,target_shipment,new_lot,movement,amount,btrim(reason),auth.uid());

  insert into public.audit_logs(actor,action,details) values(auth.uid(),'REGISTRAR_DEVOLUCAO',
    jsonb_build_object('expedicao_id',target_shipment,'devolucao_id',return_id,'lote_id',new_lot));
  update public.operation_requests set result = return_id
    where actor = auth.uid() and operation = 'REGISTRAR_DEVOLUCAO'
      and operation_requests.request_id = register_shipment_return.request_id;
  return return_id;
end
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
  perform purezza_private.lock_lot_genealogy();
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

create or replace function purezza_private.complete_batch_packaging(target_batch uuid, input jsonb, checked jsonb, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  plan public.production_orders%rowtype;
  batch public.production_batches%rowtype;
  estimate jsonb;
  product uuid;
  packaging uuid;
  label uuid;
  maker uuid;
  outlet uuid := (input->>'output_location_id')::uuid;
  output_lot uuid;
  output_move uuid;
  allocation jsonb;
  material uuid;
  material_lot uuid;
  material_location uuid;
  material_move uuid;
  debit numeric;
  finished_time timestamptz;
  manufactured date;
  term int;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode='42501',message='Seu perfil não pode finalizar a embalagem.';
  end if;
  perform purezza_private.lock_lot_genealogy();
  previous := purezza_private.claim_operation('FINALIZAR_EMBALAGEM',request_id,jsonb_build_array(target_batch,input,checked));
  if previous is not null then return previous; end if;

  select * into plan from public.production_orders where id=(
    select production_order_id from public.production_batches where id=target_batch
  ) for update;
  if not found then raise exception using errcode='22023',message='Selecione uma massada em embalagem.'; end if;
  select * into strict batch from public.production_batches where id=target_batch for update;
  if batch.status<>'EM_EMBALAGEM' or (checked->>'version')::int is distinct from batch.version then
    raise exception using errcode='40001',message='A massada mudou. Consulte a embalagem novamente.';
  end if;
  select item_id into strict product from public.production_demands where order_item_id=plan.demand_id;
  perform id from public.items where id=product for update;
  estimate := purezza_private.packaging_estimate(target_batch,input);
  if checked is distinct from estimate then raise exception using errcode='40001',message='A configuração ou os lotes mudaram. Revise a sugestão.'; end if;
  packaging := (estimate->>'package_item_id')::uuid;
  label := (estimate->>'label_item_id')::uuid;
  maker := (estimate->>'manufacturer_id')::uuid;
  perform id from public.items where id in (packaging,label) and active and classification='INSUMO' and base_unit='un'
    order by id for update;
  if not exists(select from public.items where id=packaging and active and classification='INSUMO' and base_unit='un')
    or not exists(select from public.items where id=label and active and classification='INSUMO' and base_unit='un') then
    raise exception using errcode='22023',message='Embalagem e etiqueta precisam ser insumos ativos em unidades.';
  end if;
  perform id from public.inventory_lots where item_id in (packaging,label) order by id for update;
  if checked is distinct from purezza_private.packaging_estimate(target_batch,input) then
    raise exception using errcode='40001',message='Os lotes de embalagem mudaram. Revise a sugestão.';
  end if;
  perform id from public.manufacturers where id=maker and active for share;
  if not found then raise exception using errcode='22023',message='O fabricante da configuração está inativo.'; end if;
  perform id from public.locations where id=outlet and active for share;
  if not found then raise exception using errcode='22023',message='Selecione um local ativo para quarentena.'; end if;

  manufactured := (batch.started_at at time zone 'America/Sao_Paulo')::date;
  term := (plan.recipe_snapshot->>'shelf_life_days')::int;
  if term is null or term<=0 or nullif(btrim(plan.recipe_snapshot->>'storage_conditions'),'') is null then
    raise exception using errcode='22023',message='A ficha precisa ter validade e armazenamento aprovados.';
  end if;

  insert into public.inventory_lots(item_id,manufacturer_id,original_lot,manufactured_on,expires_on,expiry,unit,production_batch_id)
  values(product,maker,batch.lot_code,manufactured,manufactured+term,'INFORMADA','un',target_batch)
  returning id into output_lot;
  insert into public.stock_balances(lot_id,location_id,quantity) values(output_lot,outlet,(estimate->>'units')::numeric);
  insert into public.stock_movements(lot_id,location_id,quantity_delta,kind,actor,correlation_id)
    values(output_lot,outlet,(estimate->>'units')::numeric,'PRODUCAO_ACABADA',auth.uid(),target_batch) returning id into output_move;
  insert into public.batch_finished_outputs(batch_id,packing_config_id,output_lot_id,output_movement_id,
    unit_count,nominal_kg,actual_kg,rejected_packages,rejected_labels,available_kg,finished_by)
  values(target_batch,(estimate->>'config_id')::uuid,output_lot,output_move,
    (estimate->>'units')::numeric,(estimate->>'nominal_kg')::numeric,(estimate->>'actual_kg')::numeric,
    (estimate->>'package_rejected')::numeric,(estimate->>'label_rejected')::numeric,(estimate->>'available_kg')::numeric,auth.uid());

  for allocation,material in
    select entry,packaging from jsonb_array_elements(estimate->'packages') entries(entry)
    union all select entry,label from jsonb_array_elements(estimate->'labels') entries(entry)
  loop
    material_lot := (allocation->>'lot_id')::uuid;
    material_location := (allocation->>'location_id')::uuid;
    debit := (allocation->>'quantity')::numeric;
    perform id from public.inventory_lots where id=material_lot and item_id=material and unit='un' and status='LIBERADO'
      and (expiry='NAO_APLICAVEL' or (expiry='INFORMADA' and expires_on>(clock_timestamp() at time zone 'America/Sao_Paulo')::date));
    if not found then raise exception using errcode='22023',message='Um lote de embalagem deixou de estar elegível.'; end if;
    perform id from public.locations where id=material_location and active for share;
    if not found then raise exception using errcode='22023',message='Um local de embalagem ficou inativo.'; end if;

    update public.stock_balances set quantity=quantity-debit
      where lot_id=material_lot and location_id=material_location and quantity>=debit;
    if not found then raise exception using errcode='22023',message='Saldo insuficiente de embalagem ou etiqueta.'; end if;
    insert into public.stock_movements(lot_id,location_id,quantity_delta,kind,actor,correlation_id)
      values(material_lot,material_location,-debit,'CONSUMO_EMBALAGEM',auth.uid(),target_batch) returning id into material_move;
    insert into public.batch_packaging_consumptions(batch_id,item_id,lot_id,location_id,quantity,movement_id)
      values(target_batch,material,material_lot,material_location,debit,material_move);
  end loop;

  finished_time := clock_timestamp();
  update public.production_batch_stages set status='CONCLUIDA',finished_at=finished_time,finished_by=auth.uid()
    where batch_id=target_batch and stage='EMBALAGEM' and status='EM_EXECUCAO';
  if not found then raise exception using errcode='22023',message='A etapa Embalagem precisa estar em execução.'; end if;
  update public.production_batches set status='FINALIZADA',version=version+1 where id=target_batch;
  update public.production_orders set packaging_config_id=coalesce(packaging_config_id,(estimate->>'config_id')::uuid),
    status=case when exists(select from public.production_batches where production_order_id=plan.id and status<>'FINALIZADA')
      then 'EM_PRODUCAO' else 'CONCLUIDA' end where id=plan.id;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'FINALIZAR_EMBALAGEM',
    jsonb_build_object('massada_id',target_batch,'lote_acabado_id',output_lot,'embalagens_rejeitadas',estimate->>'package_rejected',
      'etiquetas_rejeitadas',estimate->>'label_rejected'));
  update public.operation_requests set result=output_lot where actor=auth.uid() and operation='FINALIZAR_EMBALAGEM'
    and operation_requests.request_id=complete_batch_packaging.request_id;
  return output_lot;
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
      exists(select from public.recall_affected_batches affected where affected.batch_id=batch.id) as recalled,
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
