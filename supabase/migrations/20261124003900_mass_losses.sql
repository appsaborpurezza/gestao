create table public.loss_reasons (
  id uuid primary key default gen_random_uuid(),
  name text not null check(length(btrim(name)) between 1 and 100),
  active boolean not null default true
);
create unique index loss_reasons_name_idx on public.loss_reasons(lower(name));
insert into public.loss_reasons(name) values
  ('Fora do padrão'),('Erro de pesagem'),('Mistura'),('Cilindros'),('Aparas'),
  ('Embalagem'),('Contaminação'),('Vencimento'),('Erro operacional'),('Outros');

create table public.loss_destinations (
  id uuid primary key default gen_random_uuid(),
  name text not null check(length(btrim(name)) between 1 and 120),
  authorization_reference text not null check(length(btrim(authorization_reference)) between 1 and 500),
  authorized_by uuid not null references public.profiles,
  created_at timestamptz not null default statement_timestamp(),
  active boolean not null default true
);
create unique index loss_destinations_name_idx on public.loss_destinations(lower(name));

create table public.production_losses (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.production_batches,
  recipe_version_id uuid references public.recipe_versions,
  operation text not null check(operation in ('PREPARACAO','BATER_MASSA','CILINDROS','EMBALAGEM','OUTRA')),
  quantity_kg numeric(18,6) not null check(quantity_kg>0 and quantity_kg<>'NaN'::numeric),
  reason_id uuid not null references public.loss_reasons,
  destination_id uuid not null references public.loss_destinations,
  notes text check(length(notes)<=500),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default statement_timestamp(),
  recorded_by uuid not null references public.profiles,
  reconciled_by uuid references public.profiles,
  reconciled_at timestamptz,
  reconciliation_reason text,
  foreign key(batch_id,operation) references public.production_batch_stages(batch_id,stage),
  check(occurred_at<=recorded_at),
  check((reconciled_by is null and reconciled_at is null and reconciliation_reason is null)
    or (batch_id is not null and reconciled_by is not null and reconciled_at is not null
      and reconciliation_reason is not null and length(btrim(reconciliation_reason)) between 1 and 500))
);
create index production_losses_period_idx on public.production_losses(occurred_at desc,id);
create index production_losses_batch_idx on public.production_losses(batch_id);
create index production_losses_reason_idx on public.production_losses(reason_id,occurred_at);

do $$
declare relation text;
begin
  foreach relation in array array['loss_reasons','loss_destinations','production_losses'] loop
    execute format('alter table public.%I enable row level security',relation);
    execute format('revoke all on public.%I from public,anon,authenticated',relation);
    execute format('grant select on public.%I to authenticated',relation);
    execute format('create policy losses_operational_read on public.%I for select to authenticated
      using ((select purezza_private.has_role(''ADMINISTRADOR'',''PRODUCAO'')))',relation);
  end loop;
end
$$;

create function purezza_private.add_loss_option(kind text,label text,reference text,request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode='42501',message='Somente Administração pode configurar perdas.';
  end if;
  if kind is null or kind not in ('MOTIVO','DESTINACAO') or nullif(btrim(label),'') is null then
    raise exception using errcode='22023',message='Informe o tipo e o nome do cadastro.';
  end if;
  if kind='DESTINACAO' then
    perform id from public.profiles where id=auth.uid() and active and can_release_lot for share;
    if not found then raise exception using errcode='42501',message='A destinação exige autorização sanitária específica.'; end if;
  end if;
  result_id := purezza_private.claim_operation('CADASTRAR_OPCAO_PERDA',request_id,jsonb_build_array(kind,label,reference));
  if result_id is not null then return result_id; end if;
  if kind='MOTIVO' then
    insert into public.loss_reasons(name) values(btrim(label)) returning id into result_id;
  else
    insert into public.loss_destinations(name,authorization_reference,authorized_by)
      values(btrim(label),nullif(btrim(reference),''),auth.uid()) returning id into result_id;
  end if;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'CADASTRAR_OPCAO_PERDA',jsonb_build_object('tipo',kind,'registro_id',result_id));
  update public.operation_requests set result=result_id where actor=auth.uid() and operation='CADASTRAR_OPCAO_PERDA'
    and operation_requests.request_id=add_loss_option.request_id;
  return result_id;
end
$$;

create function purezza_private.record_mass_loss(input jsonb,request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  target_batch uuid;
  recipe uuid;
  reason uuid;
  destination uuid;
  quantity numeric;
  occurred timestamptz;
  recorded timestamptz := statement_timestamp();
  selected_operation text;
  stage_start timestamptz;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode='42501',message='Seu perfil não pode registrar perdas.';
  end if;
  if jsonb_typeof(input) is distinct from 'object' then
    raise exception using errcode='22023',message='Informe os dados da perda.';
  end if;
  result_id := purezza_private.claim_operation('REGISTRAR_PERDA_MASSA',request_id,
    to_jsonb(encode(sha256(convert_to(input::text,'UTF8')),'hex')));
  if result_id is not null then return result_id; end if;

  target_batch := nullif(input->>'batch_id','')::uuid;
  selected_operation := input->>'operation';
  quantity := (input->>'quantity_kg')::numeric;
  reason := (input->>'reason_id')::uuid;
  destination := (input->>'destination_id')::uuid;
  occurred := coalesce(nullif(input->>'occurred_local','')::timestamp at time zone 'America/Sao_Paulo',recorded);
  if quantity is null or not(quantity>0 and quantity<1000000000000) or quantity<>round(quantity,6)
    or not isfinite(occurred) or occurred>recorded then
    raise exception using errcode='22023',message='Confira o peso e o horário da perda.';
  end if;
  perform id from public.loss_reasons where id=reason and active for share;
  if not found then raise exception using errcode='22023',message='Selecione um motivo ativo.'; end if;
  perform id from public.loss_destinations where id=destination and active for share;
  if not found then raise exception using errcode='22023',message='Selecione uma destinação autorizada ativa.'; end if;
  if target_batch is not null then
    select plan.recipe_version_id,stage.started_at into recipe,stage_start
    from public.production_batches batch
    join public.production_orders plan on plan.id=batch.production_order_id
    join public.production_batch_stages stage on stage.batch_id=batch.id
      and stage.stage=selected_operation and stage.status='EM_EXECUCAO'
    where batch.id=target_batch for update of batch,stage;
    if not found or occurred<stage_start then
      raise exception using errcode='22023',message='O horário precisa pertencer à etapa em execução.';
    end if;
  else
    recipe := nullif(input->>'recipe_version_id','')::uuid;
  end if;
  insert into public.production_losses(batch_id,recipe_version_id,operation,quantity_kg,reason_id,
    destination_id,notes,occurred_at,recorded_at,recorded_by)
  values(target_batch,recipe,selected_operation,quantity,reason,destination,nullif(btrim(input->>'notes'),''),occurred,recorded,auth.uid())
  returning id into result_id;

  insert into public.audit_logs(actor,action,details) values(auth.uid(),'REGISTRAR_PERDA_MASSA',jsonb_build_object('perda_id',result_id,'massada_id',target_batch));
  update public.operation_requests set result=result_id where actor=auth.uid() and operation='REGISTRAR_PERDA_MASSA'
    and operation_requests.request_id=record_mass_loss.request_id;
  return result_id;
end
$$;

create function purezza_private.reconcile_mass_loss(target_loss uuid,target_batch uuid,target_stage text,reason text,request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  loss public.production_losses%rowtype;
  recipe uuid;
  stage_start timestamptz;
  stage_end timestamptz;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode='42501',message='Somente Administração pode conciliar perdas sem massada.';
  end if;
  previous := purezza_private.claim_operation('CONCILIAR_PERDA_MASSA',request_id,
    jsonb_build_array(target_loss,target_batch,target_stage,reason));
  if previous is not null then return previous; end if;
  if nullif(btrim(reason),'') is null or length(btrim(reason))>500 then
    raise exception using errcode='22023',message='Informe a justificativa da conciliação.';
  end if;
  select * into loss from public.production_losses where id=target_loss and batch_id is null for update;
  if not found then raise exception using errcode='22023',message='Selecione uma perda ainda sem massada.'; end if;
  select plan.recipe_version_id,stage.started_at,stage.finished_at into recipe,stage_start,stage_end
  from public.production_batches batch
  join public.production_orders plan on plan.id=batch.production_order_id
  join public.production_batch_stages stage on stage.batch_id=batch.id and stage.stage=target_stage
  where batch.id=target_batch for share of stage;
  if not found or loss.occurred_at<stage_start or loss.occurred_at>coalesce(stage_end,statement_timestamp())
    or (loss.recipe_version_id is not null and loss.recipe_version_id<>recipe) then
    raise exception using errcode='22023',message='A etapa precisa corresponder ao horário e à receita da perda.';
  end if;
  update public.production_losses set batch_id=target_batch,recipe_version_id=recipe,operation=target_stage,
    reconciled_by=auth.uid(),reconciled_at=clock_timestamp(),reconciliation_reason=reconcile_mass_loss.reason
    where id=target_loss;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'CONCILIAR_PERDA_MASSA',
    jsonb_build_object('perda_id',target_loss,'massada_id',target_batch,'operacao_anterior',loss.operation));
  update public.operation_requests set result=target_loss where actor=auth.uid() and operation='CONCILIAR_PERDA_MASSA'
    and operation_requests.request_id=reconcile_mass_loss.request_id;
  return target_loss;
end
$$;

create function public.add_loss_option(kind text,label text,reference text,request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.add_loss_option(kind,label,reference,request_id)
$$;
create function public.record_mass_loss(input jsonb,request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.record_mass_loss(input,request_id)
$$;
create function public.reconcile_mass_loss(target_loss uuid,target_batch uuid,target_stage text,reason text,request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.reconcile_mass_loss(target_loss,target_batch,target_stage,reason,request_id)
$$;
revoke all on function purezza_private.add_loss_option(text,text,text,uuid),public.add_loss_option(text,text,text,uuid),
  purezza_private.record_mass_loss(jsonb,uuid),public.record_mass_loss(jsonb,uuid),
  purezza_private.reconcile_mass_loss(uuid,uuid,text,text,uuid),public.reconcile_mass_loss(uuid,uuid,text,text,uuid)
  from public,anon,authenticated;
grant execute on function purezza_private.add_loss_option(text,text,text,uuid),public.add_loss_option(text,text,text,uuid),
  purezza_private.record_mass_loss(jsonb,uuid),public.record_mass_loss(jsonb,uuid),
  purezza_private.reconcile_mass_loss(uuid,uuid,text,text,uuid),public.reconcile_mass_loss(uuid,uuid,text,text,uuid)
  to authenticated;

create function purezza_private.mass_loss_history(from_day date,to_day date,filter_reason uuid,page_size int,page_offset int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode='42501',message='Seu perfil não pode consultar perdas.';
  end if;
  if from_day is null or to_day is null or not isfinite(from_day) or not isfinite(to_day)
    or from_day>to_day or to_day>(statement_timestamp() at time zone 'America/Sao_Paulo')::date
    or page_size is null or page_size not between 1 and 100 or page_offset is null or page_offset<0 then
    raise exception using errcode='22023',message='Confira o período e a paginação.';
  end if;
  with losses as (
    select entry.*,reason.name as reason, destination.name as destination
    from public.production_losses entry
    join public.loss_reasons reason on reason.id=entry.reason_id
    join public.loss_destinations destination on destination.id=entry.destination_id
    where entry.occurred_at>=from_day::timestamp at time zone 'America/Sao_Paulo'
      and entry.occurred_at<(to_day+1)::timestamp at time zone 'America/Sao_Paulo'
      and (filter_reason is null or entry.reason_id=filter_reason)
  ), causes as (
    select reason,sum(quantity_kg) as quantity from losses group by reason
  ), page as (
    select * from losses order by occurred_at desc,id limit page_size offset page_offset
  ), details as (
    select entry.id,entry.batch_id,batch.lot_code,entry.operation,recipe.name as recipe_name,entry.quantity_kg::text as quantity,
      entry.reason,entry.destination,entry.notes,entry.occurred_at,actor.display_name as operator,entry.reconciled_at
    from page entry
    join public.profiles actor on actor.id=entry.recorded_by
    left join public.production_batches batch on batch.id=entry.batch_id
    left join public.recipe_versions version on version.id=entry.recipe_version_id
    left join public.recipes recipe on recipe.id=version.recipe_id
  )
  select jsonb_build_object('total',(select count(*) from losses),
    'total_kg',(select coalesce(sum(quantity_kg),0)::text from losses),
    'causes',coalesce((select jsonb_agg(jsonb_build_object('reason',reason,'quantity',quantity::text)
      order by quantity desc,reason) from causes),'[]'::jsonb),
    'rows',coalesce((select jsonb_agg(to_jsonb(details) order by occurred_at desc,id) from details),'[]'::jsonb))
    into result;
  return result;
end
$$;
create function public.mass_loss_history(from_day date,to_day date,filter_reason uuid,page_size int,page_offset int)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.mass_loss_history(from_day,to_day,filter_reason,page_size,page_offset)
$$;
revoke all on function purezza_private.mass_loss_history(date,date,uuid,int,int),public.mass_loss_history(date,date,uuid,int,int)
  from public,anon,authenticated;
grant execute on function purezza_private.mass_loss_history(date,date,uuid,int,int),public.mass_loss_history(date,date,uuid,int,int)
  to authenticated;

create or replace function purezza_private.trace_production_genealogy(selected_lots uuid[])
returns jsonb language sql stable security invoker set search_path = '' as $$
  with selected_batches as (
    select production_batch_id as id from public.inventory_lots
    where id=any(selected_lots) and production_batch_id is not null
  ), raw_links as (
    select consumption.batch_id, position.lot_id, position.location_id, position.quantity,
      position.movement_id, consumption.stage, ingredient.source_name as material, 'INGREDIENTE'::text as kind
    from public.batch_ingredient_consumption_lots position
    join public.batch_ingredient_consumptions consumption on consumption.id=position.consumption_id
    join public.recipe_ingredients ingredient on ingredient.id=consumption.ingredient_id
    where position.lot_id=any(selected_lots) or consumption.batch_id in (select id from selected_batches)
    union all
    select usage.batch_id,usage.lot_id,usage.location_id,usage.quantity,usage.movement_id,'EMBALAGEM',
      coalesce(item.commercial_description,item.original_description),
      case when usage.item_id=config.package_item_id then 'EMBALAGEM' else 'ETIQUETA' end
    from public.batch_packaging_consumptions usage
    join public.batch_finished_outputs output on output.batch_id=usage.batch_id
    join public.product_packaging_configs config on config.id=output.packing_config_id
    join public.items item on item.id=usage.item_id
    where usage.lot_id=any(selected_lots) or usage.batch_id in (select id from selected_batches)
  ), relevant_batches as (
    select id from selected_batches
    union
    select batch_id from raw_links
  ), linked_batches as (
    select batch.id,batch.lot_code as batch_code,batch.sequence,batch.status,
      plan.production_number::text as production_number,plan.recipe_name,version.version as recipe_version,
      demand.item_code,demand.description as product,
      output_lot.internal_code as output_code,output_lot.status as output_status,
      output.unit_count::text as output_units,output.nominal_kg::text as nominal_kg,
      output.actual_kg::text as actual_kg,output.finished_at,actor.display_name as finished_by
    from relevant_batches batch_ids
    join public.production_batches batch on batch.id=batch_ids.id
    join public.production_orders plan on plan.id=batch.production_order_id
    join public.recipe_versions version on version.id=plan.recipe_version_id
    join public.production_demands demand on demand.order_item_id=plan.demand_id
    left join public.batch_finished_outputs output on output.batch_id=batch.id
    left join public.inventory_lots output_lot on output_lot.id=output.output_lot_id
    left join public.profiles actor on actor.id=output.finished_by
  ), links as (
    select raw.batch_id,raw.lot_id,raw.movement_id,raw.stage,raw.material,raw.kind,raw.quantity::text as quantity,
      lot.internal_code as source_code,lot.original_lot as source_original_lot,lot.expires_on,lot.unit,
      location.code as location,maker.name as manufacturer,supplier.name as supplier,
      receipt.invoice_number,lot.opening_reference,lot.opening_invoice,
      movement.created_at as consumed_at,actor.display_name as operator
    from raw_links raw
    join public.stock_movements movement on movement.id=raw.movement_id
    join public.profiles actor on actor.id=movement.actor
    join public.inventory_lots lot on lot.id=raw.lot_id
    join public.locations location on location.id=raw.location_id
    join public.manufacturers maker on maker.id=lot.manufacturer_id
    left join public.receipts receipt on receipt.id=lot.receipt_id
    left join public.suppliers supplier on supplier.id=receipt.supplier_id
  ), water as (
    select record.id,record.batch_id,record.stage,record.source,record.control_reference,record.quantity::text as quantity,
      record.unit,record.recorded_at,actor.display_name as operator
    from relevant_batches batch_ids
    join public.batch_water_records record on record.batch_id=batch_ids.id
    join public.profiles actor on actor.id=record.recorded_by
  ), waste as (
    select loss.id,loss.batch_id,loss.operation,loss.quantity_kg::text as quantity,reason.name as reason,
      destination.name as destination,loss.occurred_at,actor.display_name as operator
    from relevant_batches batch_ids join public.production_losses loss on loss.batch_id=batch_ids.id
    join public.loss_reasons reason on reason.id=loss.reason_id
    join public.loss_destinations destination on destination.id=loss.destination_id
    join public.profiles actor on actor.id=loss.recorded_by
  ), downstream as (
    select dispatch.id,batch.id as batch_id,lot.internal_code as output_code,
      purchase.order_number::text as order_number,purchase.customer_name,dispatch.quantity::text as quantity,
      lot.unit,dispatch.dispatched_at,dispatch.delivered_at,actor.display_name as operator
    from relevant_batches batch_ids
    join public.production_batches batch on batch.id=batch_ids.id
    join public.batch_finished_outputs output on output.batch_id=batch.id
    join public.inventory_lots lot on lot.id=output.output_lot_id
    join public.stock_reservations res on res.lot_id=lot.id
    join public.shipments dispatch on dispatch.reservation_id=res.id
    join public.orders purchase on purchase.id=dispatch.order_id
    join public.profiles actor on actor.id=dispatch.dispatched_by
  )
  select jsonb_build_object(
    'batches',coalesce((select jsonb_agg(to_jsonb(linked_batches) order by production_number::bigint,sequence) from linked_batches),'[]'::jsonb),
    'inputs',coalesce((select jsonb_agg(to_jsonb(links) - 'lot_id' order by consumed_at,movement_id)
      from links where batch_id in (select id from selected_batches)),'[]'::jsonb),
    'uses',coalesce((select jsonb_agg(to_jsonb(links) - 'lot_id' order by consumed_at,movement_id)
      from links where lot_id=any(selected_lots)),'[]'::jsonb),
    'losses',coalesce((select jsonb_agg(to_jsonb(waste) order by occurred_at,id) from waste),'[]'::jsonb),
    'water',coalesce((select jsonb_agg(to_jsonb(water) order by recorded_at,id) from water),'[]'::jsonb),
    'destinations',coalesce((select jsonb_agg(to_jsonb(downstream) order by dispatched_at,id) from downstream),'[]'::jsonb)
  )
$$;
