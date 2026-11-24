create table public.product_packaging_configs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.items,
  version int not null check (version > 0),
  manufacturer_id uuid not null references public.manufacturers,
  package_item_id uuid not null references public.items,
  label_item_id uuid not null references public.items,
  packages_per_unit int not null check (packages_per_unit > 0),
  labels_per_unit int not null check (labels_per_unit > 0),
  reference text not null check (length(btrim(reference)) between 1 and 500),
  configured_by uuid not null references public.profiles,
  configured_at timestamptz not null default statement_timestamp(),
  unique(product_id,version),
  check (package_item_id <> label_item_id)
);
alter table public.production_orders add column packaging_config_id uuid references public.product_packaging_configs;
alter table public.production_orders drop constraint production_orders_status_check;
alter table public.production_orders add constraint production_orders_status_check check (status in ('PLANEJADA','EM_PRODUCAO','CONCLUIDA'));
alter table public.production_batches drop constraint production_batches_status_check;
alter table public.production_batches add constraint production_batches_status_check
  check (status in ('PLANEJADA','EM_PREPARACAO','EM_BATER_MASSA','EM_CILINDROS','EM_EMBALAGEM','FINALIZADA'));
alter table public.inventory_lots add column production_batch_id uuid unique references public.production_batches;
alter table public.inventory_lots drop constraint inventory_lot_origin_check;
alter table public.inventory_lots add constraint inventory_lot_origin_check check (
  num_nonnulls(receipt_id,opening_location_id,return_shipment_id,production_batch_id)=1
  and ((opening_location_id is null and num_nonnulls(opening_reference,opening_invoice,opened_at,opened_by)=0)
    or (opening_location_id is not null and nullif(btrim(opening_reference),'') is not null and opened_at is not null and opened_by is not null))
);
alter table public.stock_movements drop constraint stock_movements_kind_check;
alter table public.stock_movements add constraint stock_movements_kind_check
  check (kind in ('RECEBIMENTO','TRANSFERENCIA','AJUSTE_INVENTARIO','ABERTURA_INVENTARIO',
    'EXPEDICAO','DEVOLUCAO_EXPEDICAO','CONSUMO_PREPARACAO','CONSUMO_BATER_MASSA','CONSUMO_EMBALAGEM','PRODUCAO_ACABADA'));

create table public.batch_finished_outputs (
  batch_id uuid primary key references public.production_batches,
  packing_config_id uuid not null references public.product_packaging_configs,
  output_lot_id uuid not null unique references public.inventory_lots,
  output_movement_id uuid not null unique references public.stock_movements,
  unit_count numeric(18,6) not null check (unit_count > 0 and unit_count=trunc(unit_count)),
  nominal_kg numeric not null check (nominal_kg > 0),
  actual_kg numeric check (actual_kg > 0),
  rejected_packages numeric(18,6) not null check (rejected_packages >= 0),
  rejected_labels numeric(18,6) not null check (rejected_labels >= 0),
  available_kg numeric not null check (available_kg > 0 and available_kg >= nominal_kg
    and (actual_kg is null or actual_kg <= available_kg)),
  finished_by uuid not null references public.profiles,
  finished_at timestamptz not null default statement_timestamp()
);
create table public.batch_packaging_consumptions (
  batch_id uuid not null references public.batch_finished_outputs,
  item_id uuid not null references public.items,
  lot_id uuid not null,
  location_id uuid not null,
  quantity numeric(18,6) not null check (quantity > 0),
  movement_id uuid not null unique references public.stock_movements,
  primary key(batch_id,item_id,lot_id,location_id),
  foreign key(lot_id,location_id) references public.stock_balances
);
create index packaging_consumptions_lot_idx on public.batch_packaging_consumptions(lot_id,location_id);

do $$
declare relation text;
begin
  foreach relation in array array['product_packaging_configs','batch_finished_outputs','batch_packaging_consumptions'] loop
    execute format('alter table public.%I enable row level security',relation);
    execute format('revoke all on public.%I from public, anon, authenticated',relation);
    execute format('grant select on public.%I to authenticated',relation);
    execute format('create policy packing_technical_read on public.%I for select to authenticated
      using ((select purezza_private.has_role(''ADMINISTRADOR'',''PRODUCAO'')))',relation);
  end loop;
end
$$;

create function purezza_private.save_packaging_config(target_product uuid, expected_config uuid, input jsonb, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  current_config public.product_packaging_configs%rowtype;
  maker uuid;
  package_item uuid;
  label_item uuid;
  package_count int;
  label_count int;
  reference_text text;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode='42501',message='Somente Administração configura embalagens.';
  end if;
  result_id := purezza_private.claim_operation('CONFIGURAR_EMBALAGEM',request_id,jsonb_build_array(target_product,expected_config,input));
  if result_id is not null then return result_id; end if;
  maker := (input->>'manufacturer_id')::uuid;
  package_item := (input->>'package_item_id')::uuid;
  label_item := (input->>'label_item_id')::uuid;
  package_count := (input->>'packages_per_unit')::int;
  label_count := (input->>'labels_per_unit')::int;
  reference_text := nullif(btrim(input->>'reference'),'');
  if maker is null or package_item is null or label_item is null or package_item=label_item
    or package_count is null or package_count<=0 or label_count is null or label_count<=0
    or reference_text is null or length(reference_text)>500 then
    raise exception using errcode='22023',message='Confira fabricante, embalagem, etiqueta, quantidades e referência.';
  end if;
  perform id from public.items where id=target_product and classification='FABRICACAO_PROPRIA' and base_unit='un' and active for update;
  if not found then raise exception using errcode='22023',message='Selecione um produto próprio ativo com unidade base un.'; end if;
  select * into current_config from public.product_packaging_configs where product_id=target_product order by version desc limit 1;
  if current_config.id is distinct from expected_config then
    raise exception using errcode='40001',message='A configuração mudou. Atualize a consulta.';
  end if;
  perform id from public.manufacturers where id=maker and active for share;
  if not found then raise exception using errcode='22023',message='Selecione o fabricante ativo.'; end if;
  perform id from public.items where id in (package_item,label_item) and classification='INSUMO' and base_unit='un' and active order by id for share;
  if not exists(select from public.items where id=package_item and classification='INSUMO' and base_unit='un' and active)
    or not exists(select from public.items where id=label_item and classification='INSUMO' and base_unit='un' and active) then
    raise exception using errcode='22023',message='Embalagem e etiqueta precisam ser insumos ativos em unidades.';
  end if;

  insert into public.product_packaging_configs(product_id,version,manufacturer_id,package_item_id,label_item_id,
    packages_per_unit,labels_per_unit,reference,configured_by)
  values(target_product,coalesce(current_config.version,0)+1,maker,package_item,label_item,package_count,label_count,reference_text,auth.uid())
  returning id into result_id;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'CONFIGURAR_EMBALAGEM',jsonb_build_object('produto_id',target_product,'config_id',result_id));
  update public.operation_requests set result=result_id where actor=auth.uid() and operation='CONFIGURAR_EMBALAGEM'
    and operation_requests.request_id=save_packaging_config.request_id;
  return result_id;
end
$$;

create function purezza_private.capture_packaging_config()
returns trigger language plpgsql set search_path = '' as $$
begin
  select cfg.id into new.packaging_config_id from public.product_packaging_configs cfg
    join public.production_demands demand on demand.item_id=cfg.product_id
    where demand.order_item_id=new.demand_id order by cfg.version desc limit 1;
  return new;
end
$$;
revoke all on function purezza_private.capture_packaging_config() from public, anon, authenticated;
create trigger capture_packaging_config before insert on public.production_orders
  for each row execute function purezza_private.capture_packaging_config();

create function purezza_private.packaging_estimate(target_batch uuid, input jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  batch public.production_batches%rowtype;
  plan public.production_orders%rowtype;
  demand public.production_demands%rowtype;
  cfg public.product_packaging_configs%rowtype;
  units numeric;
  declared_mass numeric;
  actual_mass numeric;
  measured_mass numeric;
  nominal_mass numeric;
  factor numeric;
  package_extra numeric;
  label_extra numeric;
  package_total numeric;
  label_total numeric;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode='42501',message='Seu perfil não pode apontar embalagem.';
  end if;
  select * into batch from public.production_batches where id=target_batch and status='EM_EMBALAGEM';
  if not found then raise exception using errcode='22023',message='A massada precisa estar em Embalagem.'; end if;
  select * into strict plan from public.production_orders where id=batch.production_order_id;
  select * into strict demand from public.production_demands where order_item_id=plan.demand_id;
  select * into cfg from public.product_packaging_configs where product_id=demand.item_id
    and (plan.packaging_config_id is null or id=plan.packaging_config_id) order by version desc limit 1;
  select kg_per_unit into factor from public.order_items where id=demand.order_item_id and unit='un';
  if cfg.id is null or factor is null or not exists(
    select from public.items where id=demand.item_id and active and base_unit='un'
  ) then
    raise exception using errcode='22023',message='Configure a embalagem e a conversão aprovada para este produto em unidades.';
  end if;

  units := (input->>'units')::numeric;
  declared_mass := nullif(input->>'available_kg','')::numeric;
  actual_mass := nullif(input->>'actual_kg','')::numeric;
  package_extra := nullif(input->>'package_rejected','')::numeric;
  label_extra := nullif(input->>'label_rejected','')::numeric;
  if units is null or not (units>0 and units<1000000000000) or units<>trunc(units)
    or exists(select from unnest(array[declared_mass,actual_mass]) weight
      where not (weight>0 and weight<1000000000000) or weight<>round(weight,6))
    or package_extra is null or label_extra is null
    or exists(select from unnest(array[package_extra,label_extra]) quantity
      where not (quantity>=0 and quantity<1000000000000) or quantity<>trunc(quantity)) then
    raise exception using errcode='22023',message='Confira unidades conformes, rejeições e pesos medidos.';
  end if;

  select measured_kg into measured_mass from public.production_batch_stages
    where batch_id=target_batch and stage in ('CILINDROS','BATER_MASSA') and measured_kg is not null
    order by (stage='CILINDROS') desc limit 1;
  if declared_mass is not null and measured_mass is not null and declared_mass>measured_mass then
    raise exception using errcode='22023',message='A massa disponível não pode superar a medição anterior.';
  end if;
  measured_mass := coalesce(declared_mass,measured_mass);
  nominal_mass := units*factor;
  if measured_mass is null or nominal_mass>measured_mass or actual_mass>measured_mass then
    raise exception using errcode='22023',message='Informe a massa disponível medida e confira a quantidade embalada.';
  end if;
  package_total := units*cfg.packages_per_unit+package_extra;
  label_total := units*cfg.labels_per_unit+label_extra;
  if package_total>=1000000000000 or label_total>=1000000000000 then
    raise exception using errcode='22023',message='O consumo de embalagem ou etiqueta excede a capacidade do registro.';
  end if;
  return jsonb_build_object('version',batch.version,'config_id',cfg.id,'product_id',demand.item_id,
    'manufacturer_id',cfg.manufacturer_id,'units',units::text,'available_kg',measured_mass::text,
    'nominal_kg',nominal_mass::text,'actual_kg',actual_mass::text,
    'package_item_id',cfg.package_item_id,'label_item_id',cfg.label_item_id,
    'package_rejected',package_extra::text,'label_rejected',label_extra::text,
    'packages',purezza_private.preparation_allocations(cfg.package_item_id,package_total),
    'labels',purezza_private.preparation_allocations(cfg.label_item_id,label_total));
end
$$;

create function purezza_private.complete_batch_packaging(target_batch uuid, input jsonb, checked jsonb, request_id uuid)
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

create function public.save_packaging_config(target_product uuid, expected_config uuid, input jsonb, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.save_packaging_config(target_product,expected_config,input,request_id)
$$;
create function public.preview_batch_packaging(target_batch uuid,input jsonb)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.packaging_estimate(target_batch,input)
$$;
create function public.complete_batch_packaging(target_batch uuid,input jsonb,checked jsonb,request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.complete_batch_packaging(target_batch,input,checked,request_id)
$$;
revoke all on function purezza_private.save_packaging_config(uuid,uuid,jsonb,uuid),public.save_packaging_config(uuid,uuid,jsonb,uuid),
  purezza_private.packaging_estimate(uuid,jsonb),public.preview_batch_packaging(uuid,jsonb),
  purezza_private.complete_batch_packaging(uuid,jsonb,jsonb,uuid),public.complete_batch_packaging(uuid,jsonb,jsonb,uuid)
  from public,anon,authenticated;
grant execute on function purezza_private.save_packaging_config(uuid,uuid,jsonb,uuid),public.save_packaging_config(uuid,uuid,jsonb,uuid),
  purezza_private.packaging_estimate(uuid,jsonb),public.preview_batch_packaging(uuid,jsonb),
  purezza_private.complete_batch_packaging(uuid,jsonb,jsonb,uuid),public.complete_batch_packaging(uuid,jsonb,jsonb,uuid) to authenticated;

create or replace function purezza_private.request_inventory_label(target_lot uuid, request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  request_record uuid;
  snapshot jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode emitir etiquetas de estoque.';
  end if;

  request_record := purezza_private.claim_operation('ETIQUETA_LOTE', request_id, jsonb_build_array(target_lot));
  if request_record is not null then
    select label_snapshot into strict snapshot from public.inventory_label_requests where id = request_record;
    return snapshot;
  end if;

  perform id from public.inventory_lots where id = target_lot for share;
  select jsonb_build_object(
    'internal_code', lot.internal_code,
    'original_lot', lot.original_lot,
    'description', coalesce(item.commercial_description, item.original_description),
    'manufacturer', maker.name,
    'manufactured_on', lot.manufactured_on,
    'expires_on', lot.expires_on,
    'expiry', lot.expiry,
    'initial_quantity', first_movement.quantity_delta::text,
    'unit', lot.unit,
    'initial_location', initial_location.code,
    'document', coalesce(receipt.invoice_number, lot.opening_invoice, original_order.order_number::text, production.production_number::text),
    'document_type', case when production.id is not null then 'Ordem de produção'
      when original_order.id is not null then 'Pedido de origem'
      when receipt.id is null then 'Documento de origem' else 'NF' end
  ) into snapshot
  from public.inventory_lots lot
  join public.items item on item.id = lot.item_id
  join public.manufacturers maker on maker.id = lot.manufacturer_id
  left join public.receipts receipt on receipt.id = lot.receipt_id
  left join public.shipments dispatch on dispatch.id = lot.return_shipment_id
  left join public.orders original_order on original_order.id = dispatch.order_id
  left join public.production_batches batch on batch.id=lot.production_batch_id
  left join public.production_orders production on production.id=batch.production_order_id
  join public.stock_movements first_movement on first_movement.lot_id = lot.id
    and first_movement.kind in ('RECEBIMENTO', 'ABERTURA_INVENTARIO', 'DEVOLUCAO_EXPEDICAO','PRODUCAO_ACABADA')
  join public.locations initial_location on initial_location.id = first_movement.location_id
  where lot.id = target_lot;
  if snapshot is null then
    raise exception using errcode = '22023', message = 'A etiqueta exige um lote com entrada inicial registrada.';
  end if;

  insert into public.inventory_label_requests(lot_id, actor, label_snapshot)
    values(target_lot, auth.uid(), snapshot) returning id into request_record;
  update public.operation_requests set result = request_record
    where actor = auth.uid() and operation = 'ETIQUETA_LOTE'
      and operation_requests.request_id = request_inventory_label.request_id;
  return snapshot;
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

create or replace function purezza_private.trace_inventory_lot(internal_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  target uuid;
  report jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode consultar a rastreabilidade operacional.';
  end if;
  if internal_code is null or internal_code !~ '^REC-[a-f0-9]{32}$' then
    raise exception using errcode = '22023', message = 'Informe um código interno de lote válido.';
  end if;

  select id into target from public.inventory_lots lot where lot.internal_code = trace_inventory_lot.internal_code;
  if target is null then return null; end if;

  with recursive lineage as (
    select target as lot_id, 0 as depth, array[target] as path
    union all
    select reservation.lot_id, lineage.depth + 1, lineage.path || reservation.lot_id
    from lineage
    join public.inventory_lots child on child.id = lineage.lot_id
    join public.shipments dispatch on dispatch.id = child.return_shipment_id
    join public.stock_reservations reservation on reservation.id = dispatch.reservation_id
    where reservation.lot_id <> all(lineage.path)
  ), root as (
    select lot_id from lineage order by depth desc limit 1
  ), family as (
    select root.lot_id, null::uuid as parent_id, array[root.lot_id] as path from root
    union all
    select returned.return_lot_id, family.lot_id, family.path || returned.return_lot_id
    from family
    join public.stock_reservations reservation on reservation.lot_id = family.lot_id
    join public.shipments dispatch on dispatch.reservation_id = reservation.id
    join public.shipment_returns returned on returned.shipment_id = dispatch.id
    where returned.return_lot_id <> all(family.path)
  ), lots as (
    select lot.id, lot.internal_code as code, lot.original_lot, lot.status, lot.unit, lot.expiry,
      lot.manufactured_on, lot.expires_on,
      maker.name as manufacturer, supplier.name as supplier, receipt.invoice_number,
      receipt.documentation_reason, receipt.received_at, lot.opening_reference, lot.opening_invoice, lot.opened_at,
      origin_location.code as opening_location, opened_profile.display_name as opened_by,
      lot.return_shipment_id, produced.lot_code as production_code, plan.production_number::text as production_number,
      returned.reason as return_reason, parent.internal_code as parent_code,
      case when lot.return_shipment_id is not null then 'DEVOLUCAO'
        when lot.receipt_id is not null then 'RECEBIMENTO'
        when lot.production_batch_id is not null then 'PRODUCAO' else 'INVENTARIO_INICIAL' end as origin
    from family
    join public.inventory_lots lot on lot.id = family.lot_id
    join public.manufacturers maker on maker.id = lot.manufacturer_id
    left join public.inventory_lots parent on parent.id = family.parent_id
    left join public.receipts receipt on receipt.id = lot.receipt_id
    left join public.suppliers supplier on supplier.id = receipt.supplier_id
    left join public.locations origin_location on origin_location.id = lot.opening_location_id
    left join public.profiles opened_profile on opened_profile.id = lot.opened_by
    left join public.shipment_returns returned on returned.return_lot_id = lot.id
    left join public.production_batches produced on produced.id=lot.production_batch_id
    left join public.production_orders plan on plan.id=produced.production_order_id
  ), balances as (
    select lot.code, lot.unit, location.code as location, balance.quantity::text as physical,
      coalesce((
        select sum(res.quantity-res.dispatched_quantity) from public.stock_reservations res
        where res.lot_id = lot.id and res.location_id = balance.location_id and res.released_at is null
      ),0)::text as reserved
    from lots lot join public.stock_balances balance on balance.lot_id = lot.id
    join public.locations location on location.id = balance.location_id
  ), movements as (
    select movement.id, lot.code, lot.unit, location.code as location, movement.kind, movement.quantity_delta::text as delta,
      movement.created_at, actor.display_name as operator, movement.correlation_id
    from lots lot join public.stock_movements movement on movement.lot_id = lot.id
    join public.locations location on location.id = movement.location_id
    join public.profiles actor on actor.id = movement.actor
  ), decisions as (
    select decision.id,lot.code,decision.old_status,decision.new_status,decision.reason,decision.created_at,
      actor.display_name as operator
    from lots lot join public.lot_releases decision on decision.lot_id = lot.id
    join public.profiles actor on actor.id = decision.actor
  ), destinations as (
    select dispatch.id,lot.code,lot.unit,location.code as location,purchase.order_number::text as order_number,
      purchase.customer_name,dispatch.method,dispatch.quantity::text as quantity,dispatch.dispatched_at,
      dispatch.delivered_at,actor.display_name as operator
    from lots lot
    join public.stock_reservations reservation on reservation.lot_id = lot.id
    join public.shipments dispatch on dispatch.reservation_id = reservation.id
    join public.orders purchase on purchase.id = dispatch.order_id
    join public.locations location on location.id = reservation.location_id
    join public.profiles actor on actor.id = dispatch.dispatched_by
  )
  select jsonb_build_object(
    'selected_code',trace_inventory_lot.internal_code,
    'root_code',(select code from lots join root on root.lot_id = lots.id),
    'item',(select jsonb_build_object('code',product.original_code,
      'description',coalesce(product.commercial_description,product.original_description))
      from public.inventory_lots lot join public.items product on product.id = lot.item_id where lot.id = target),
    'lots',coalesce((select jsonb_agg(to_jsonb(lots) - 'id' order by code) from lots),'[]'::jsonb),
    'balances',coalesce((select jsonb_agg(to_jsonb(balances) order by code,location) from balances),'[]'::jsonb),
    'movements',coalesce((select jsonb_agg(to_jsonb(movements) order by created_at,id) from movements),'[]'::jsonb),
    'decisions',coalesce((select jsonb_agg(to_jsonb(decisions) order by created_at,id) from decisions),'[]'::jsonb),
    'destinations',coalesce((select jsonb_agg(to_jsonb(destinations) order by dispatched_at,id) from destinations),'[]'::jsonb)
  ) into report;
  return report;
end
$$;
