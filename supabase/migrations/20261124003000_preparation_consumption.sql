alter table public.stock_movements drop constraint stock_movements_kind_check;
alter table public.stock_movements add constraint stock_movements_kind_check
  check (kind in ('RECEBIMENTO','TRANSFERENCIA','AJUSTE_INVENTARIO','ABERTURA_INVENTARIO',
    'EXPEDICAO','DEVOLUCAO_EXPEDICAO','CONSUMO_PREPARACAO'));

create table public.batch_ingredient_consumptions (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.production_batches,
  ingredient_id uuid not null references public.recipe_ingredients,
  item_id uuid not null references public.items,
  quantity numeric(18,6) not null check (quantity > 0),
  unit text not null check (unit in ('kg','g','L','mL','un')),
  actor uuid not null references public.profiles,
  consumed_at timestamptz not null default statement_timestamp(),
  unique(batch_id,ingredient_id)
);
create index batch_ingredient_consumptions_item_idx on public.batch_ingredient_consumptions(item_id);
create table public.batch_ingredient_consumption_lots (
  consumption_id uuid not null references public.batch_ingredient_consumptions,
  lot_id uuid not null,
  location_id uuid not null,
  quantity numeric(18,6) not null check (quantity > 0),
  movement_id uuid not null unique references public.stock_movements,
  primary key(consumption_id,lot_id,location_id),
  foreign key(lot_id,location_id) references public.stock_balances
);
create index batch_ingredient_consumption_lots_position_idx
  on public.batch_ingredient_consumption_lots(lot_id,location_id);

do $$
declare relation text;
begin
  foreach relation in array array['batch_ingredient_consumptions','batch_ingredient_consumption_lots'] loop
    execute format('alter table public.%I enable row level security',relation);
    execute format('revoke all on public.%I from public, anon, authenticated',relation);
    execute format('grant select on public.%I to authenticated',relation);
    execute format('create policy consumption_technical_read on public.%I for select to authenticated
      using ((select purezza_private.has_role(''ADMINISTRADOR'',''PRODUCAO'')))',relation);
  end loop;
end
$$;

create function purezza_private.preparation_item(target_batch uuid, target_ingredient uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select entry
  from public.production_batches batch
  join public.production_orders plan on plan.id = batch.production_order_id
  cross join lateral jsonb_array_elements(plan.recipe_snapshot->'ingredients') source(entry)
  where batch.id = target_batch and batch.status = 'EM_PREPARACAO'
    and entry->>'stage' = 'PREPARACAO' and entry->>'source_ingredient_id' = target_ingredient::text
    and lower(btrim(entry->>'name')) not in ('água','agua')
$$;

create function purezza_private.preparation_amount(ingredient jsonb, amount numeric)
returns numeric language plpgsql immutable set search_path = '' as $$
declare
  base_amount numeric;
  expected numeric := (ingredient->>'quantity')::numeric;
begin
  if ingredient is null or ingredient->>'item_id' is null or expected is null
    or ingredient->>'lower_tolerance' is null or ingredient->>'upper_tolerance' is null then
    raise exception using errcode = '22023', message = 'Selecione um ingrediente da etapa de preparação em execução.';
  end if;
  if amount is null or not (amount > 0 and amount < 1000000000000) or amount <> round(amount,6)
    or (ingredient->>'unit' = 'un' and amount <> trunc(amount))
    or amount < expected - (ingredient->>'lower_tolerance')::numeric
    or amount > expected + (ingredient->>'upper_tolerance')::numeric then
    raise exception using errcode = '22023', message = 'A quantidade está fora da tolerância da ficha aprovada.';
  end if;
  base_amount := amount * case
    when ingredient->>'unit' = ingredient->>'base_unit' then 1
    when (ingredient->>'unit',ingredient->>'base_unit') in (('g','kg'),('mL','L')) then 0.001
    when (ingredient->>'unit',ingredient->>'base_unit') in (('kg','g'),('L','mL')) then 1000
  end;
  if base_amount is null or base_amount <> round(base_amount,6) or base_amount >= 1000000000000 then
    raise exception using errcode = '22023', message = 'A quantidade não cabe na precisão da unidade de estoque.';
  end if;
  return base_amount;
end
$$;

create function purezza_private.preparation_allocations(target_item uuid, amount numeric)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  result jsonb;
  covered numeric;
begin
  select coalesce(sum(lot.suggested_quantity),0),
    coalesce(jsonb_agg(jsonb_build_object('lot_id',lot.lot_id,'location_id',lot.location_id,
      'quantity',lot.suggested_quantity::numeric(18,6)::text,
      'code',lot.internal_code,'location',location.code,'expires_on',lot.expires_on) order by position),'[]'::jsonb)
  into covered,result
  from public.suggest_fefo_lots(target_item,amount) with ordinality
    as lot(lot_id,location_id,internal_code,expires_on,suggested_quantity,position)
  join public.locations location on location.id = lot.location_id;
  if covered <> amount then
    raise exception using errcode = '22023', message = 'Saldo elegível insuficiente para confirmar a pesagem.';
  end if;
  return result;
end
$$;

create function public.preparation_checklist(target_batch uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode consultar a ficha da massada.';
  end if;
  select jsonb_build_object('version',batch.version,'items',coalesce((
    select jsonb_agg(entry || jsonb_build_object('consumed',consumption.quantity::text) order by position)
    from jsonb_array_elements(plan.recipe_snapshot->'ingredients') with ordinality source(entry,position)
    left join public.batch_ingredient_consumptions consumption
      on consumption.batch_id = batch.id and consumption.ingredient_id = (entry->>'source_ingredient_id')::uuid
    where entry->>'stage' = 'PREPARACAO'
  ),'[]'::jsonb)) into result
  from public.production_batches batch join public.production_orders plan on plan.id=batch.production_order_id
  where batch.id = target_batch and batch.status = 'EM_PREPARACAO';
  return result;
end
$$;

create function purezza_private.preview_preparation_ingredient(target_batch uuid, target_ingredient uuid, amount numeric)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare ingredient jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode consultar a pesagem.';
  end if;
  ingredient := purezza_private.preparation_item(target_batch,target_ingredient);
  return purezza_private.preparation_allocations((ingredient->>'item_id')::uuid,
    purezza_private.preparation_amount(ingredient,amount));
end
$$;

create function purezza_private.confirm_preparation_ingredient(
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
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode confirmar pesagens.';
  end if;
  previous := purezza_private.claim_operation('PESAR_INGREDIENTE',request_id,
    jsonb_build_array(target_batch,target_ingredient,expected_version,amount,expected_allocations));
  if previous is not null then return previous; end if;

  select * into batch from public.production_batches where id = target_batch for update;
  if not found or batch.status <> 'EM_PREPARACAO' or batch.version is distinct from expected_version then
    raise exception using errcode = '40001', message = 'A massada mudou. Atualize a ficha antes de confirmar.';
  end if;
  if exists(select from public.batch_ingredient_consumptions where batch_id=target_batch and ingredient_id=target_ingredient) then
    raise exception using errcode = '23505', message = 'Este ingrediente já foi apontado na massada.';
  end if;

  ingredient := purezza_private.preparation_item(target_batch,target_ingredient);
  base_amount := purezza_private.preparation_amount(ingredient,amount);
  stock_item := (ingredient->>'item_id')::uuid;
  perform id from public.items where id=stock_item and active and base_unit=ingredient->>'base_unit' for update;
  if not found then raise exception using errcode = '22023', message = 'O insumo está inativo ou sua unidade mudou.'; end if;
  select array(select id from public.inventory_lots where item_id=stock_item order by id for update) into locked_lots;

  preview := purezza_private.preparation_allocations(stock_item,base_amount);
  if expected_allocations is distinct from preview then
    raise exception using errcode = '40001', message = 'Os lotes FEFO mudaram. Confira a sugestão atual antes de confirmar.';
  end if;

  insert into public.batch_ingredient_consumptions(id,batch_id,ingredient_id,item_id,quantity,unit,actor)
    values(consumption,target_batch,target_ingredient,stock_item,amount,ingredient->>'unit',auth.uid());
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
      values(target_lot,target_location,-debit,'CONSUMO_PREPARACAO',auth.uid(),consumption) returning id into movement;
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

create function public.preview_preparation_ingredient(target_batch uuid,target_ingredient uuid,amount numeric)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.preview_preparation_ingredient(target_batch,target_ingredient,amount)
$$;
create function public.confirm_preparation_ingredient(target_batch uuid,target_ingredient uuid,expected_version int,amount numeric,
  expected_allocations jsonb,request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.confirm_preparation_ingredient(target_batch,target_ingredient,expected_version,amount,expected_allocations,request_id)
$$;

revoke all on function purezza_private.preparation_item(uuid,uuid), purezza_private.preparation_amount(jsonb,numeric),
  purezza_private.preparation_allocations(uuid,numeric), public.preparation_checklist(uuid),
  purezza_private.preview_preparation_ingredient(uuid,uuid,numeric), public.preview_preparation_ingredient(uuid,uuid,numeric),
  purezza_private.confirm_preparation_ingredient(uuid,uuid,int,numeric,jsonb,uuid),
  public.confirm_preparation_ingredient(uuid,uuid,int,numeric,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.preparation_checklist(uuid), purezza_private.preview_preparation_ingredient(uuid,uuid,numeric),
  public.preview_preparation_ingredient(uuid,uuid,numeric), purezza_private.preparation_item(uuid,uuid),
  purezza_private.preparation_amount(jsonb,numeric), purezza_private.preparation_allocations(uuid,numeric),
  purezza_private.confirm_preparation_ingredient(uuid,uuid,int,numeric,jsonb,uuid),
  public.confirm_preparation_ingredient(uuid,uuid,int,numeric,jsonb,uuid) to authenticated;
