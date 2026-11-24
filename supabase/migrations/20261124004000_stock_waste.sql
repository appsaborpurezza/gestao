alter table public.stock_movements drop constraint stock_movements_kind_check;
alter table public.stock_movements add constraint stock_movements_kind_check
  check (kind in ('RECEBIMENTO','TRANSFERENCIA','AJUSTE_INVENTARIO','ABERTURA_INVENTARIO',
    'EXPEDICAO','DEVOLUCAO_EXPEDICAO','CONSUMO_PREPARACAO','CONSUMO_BATER_MASSA',
    'CONSUMO_EMBALAGEM','PRODUCAO_ACABADA','DESCARTE_ESTOQUE'));

create table public.stock_waste_records (
  id uuid primary key default gen_random_uuid(),
  stock_movement_id uuid not null unique references public.stock_movements,
  lot_id uuid not null,
  location_id uuid not null,
  category text not null check (category in ('INSUMO','EMBALAGEM','VENCIMENTO_ACABADO','OUTRO_ACABADO')),
  quantity numeric(18,6) not null check (quantity>0 and quantity<>'NaN'::numeric),
  unit text not null check (unit in ('kg','g','L','mL','un')),
  lot_status public.lot_status not null,
  reason_id uuid not null references public.loss_reasons,
  destination_id uuid not null references public.loss_destinations,
  notes text check(length(notes)<=500),
  discarded_by uuid not null references public.profiles,
  discarded_at timestamptz not null default statement_timestamp(),
  foreign key(lot_id,location_id) references public.stock_balances
);
create index stock_waste_records_period_idx on public.stock_waste_records(discarded_at desc,id);
create index stock_waste_records_position_idx on public.stock_waste_records(lot_id,location_id);

alter table public.stock_waste_records enable row level security;
revoke all on public.stock_waste_records from public,anon,authenticated;
grant select on public.stock_waste_records to authenticated;
create policy stock_waste_operational_read on public.stock_waste_records for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR','PRODUCAO')));

create function purezza_private.discard_stock(input jsonb,request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  waste_id uuid := gen_random_uuid();
  lot public.inventory_lots%rowtype;
  location uuid;
  reason uuid;
  destination uuid;
  amount numeric;
  waste_category text;
  item_class text;
  movement uuid;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode='42501',message='O descarte de estoque exige perfil administrador.';
  end if;
  if jsonb_typeof(input) is distinct from 'object' then
    raise exception using errcode='22023',message='Informe o lote e os dados do descarte.';
  end if;
  result_id := purezza_private.claim_operation('DESCARTAR_ESTOQUE',request_id,
    to_jsonb(encode(sha256(convert_to(input::text,'UTF8')),'hex')));
  if result_id is not null then return result_id; end if;

  select * into lot from public.inventory_lots where id=(input->>'lot_id')::uuid for update;
  if not found then raise exception using errcode='22023',message='Selecione um lote de estoque.'; end if;
  if lot.return_shipment_id is not null or exists(select from public.recall_affected_lots where lot_id=lot.id) then
    perform id from public.profiles where id=auth.uid() and active and can_release_lot for share;
    if not found then
      raise exception using errcode='42501',message='Descartar devoluções ou lotes recolhidos exige autorização sanitária específica.';
    end if;
  end if;
  select classification into strict item_class from public.items where id=lot.item_id;
  location := (input->>'location_id')::uuid;
  reason := (input->>'reason_id')::uuid;
  destination := (input->>'destination_id')::uuid;
  waste_category := input->>'category';
  amount := (input->>'quantity')::numeric;
  if amount is null or not(amount>0 and amount<1000000000000) or amount<>round(amount,6)
    or (lot.unit='un' and amount<>trunc(amount)) or length(btrim(input->>'notes'))>500
    or waste_category is null or waste_category not in ('INSUMO','EMBALAGEM','VENCIMENTO_ACABADO','OUTRO_ACABADO')
    or (waste_category='EMBALAGEM' and item_class<>'INSUMO')
    or (waste_category='INSUMO' and item_class not in ('INSUMO','FARINHA_USO_REVENDA_A_VALIDAR'))
    or (waste_category in ('VENCIMENTO_ACABADO','OUTRO_ACABADO') and item_class='INSUMO')
    or (waste_category='VENCIMENTO_ACABADO' and (lot.expires_on is null or lot.expires_on>
      (clock_timestamp() at time zone 'America/Sao_Paulo')::date)) then
    raise exception using errcode='22023',message='Confira a quantidade, a categoria e a validade do lote.';
  end if;
  perform id from public.locations where id=location and active for share;
  if not found then raise exception using errcode='22023',message='Selecione um local ativo.'; end if;
  perform id from public.loss_reasons where id=reason and active for share;
  if not found then raise exception using errcode='22023',message='Selecione um motivo ativo.'; end if;
  perform id from public.loss_destinations where id=destination and active for share;
  if not found then raise exception using errcode='22023',message='Selecione uma destinação autorizada ativa.'; end if;

  update public.stock_balances set quantity=quantity-amount where lot_id=lot.id and location_id=location and quantity>=amount;
  if not found then raise exception using errcode='22023',message='Saldo físico insuficiente para descarte.'; end if;
  insert into public.stock_movements(lot_id,location_id,quantity_delta,kind,actor,correlation_id)
    values(lot.id,location,-amount,'DESCARTE_ESTOQUE',auth.uid(),waste_id) returning id into movement;
  insert into public.stock_waste_records(id,stock_movement_id,lot_id,location_id,category,quantity,unit,lot_status,
    reason_id,destination_id,notes,discarded_by)
  values(waste_id,movement,lot.id,location,waste_category,amount,lot.unit,lot.status,
    reason,destination,nullif(btrim(input->>'notes'),''),auth.uid());
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'DESCARTAR_ESTOQUE',
    jsonb_build_object('perda_estoque_id',waste_id,'lote_id',lot.id,'movimento_id',movement));
  update public.operation_requests set result=waste_id where actor=auth.uid() and operation='DESCARTAR_ESTOQUE'
    and operation_requests.request_id=discard_stock.request_id;
  return waste_id;
end
$$;

create function purezza_private.stock_waste_history(from_day date,to_day date,filter_category text,page_size int,page_offset int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode='42501',message='Seu perfil não pode consultar descartes.';
  end if;
  if from_day is null or to_day is null or not isfinite(from_day) or not isfinite(to_day)
    or from_day>to_day or to_day>(statement_timestamp() at time zone 'America/Sao_Paulo')::date
    or (filter_category is not null and filter_category not in ('INSUMO','EMBALAGEM','VENCIMENTO_ACABADO','OUTRO_ACABADO'))
    or page_size is null or page_size not between 1 and 100 or page_offset is null or page_offset<0 then
    raise exception using errcode='22023',message='Confira o filtro e a paginação.';
  end if;
  with eligible as (
    select * from public.stock_waste_records where discarded_at>=from_day::timestamp at time zone 'America/Sao_Paulo'
      and discarded_at<(to_day+1)::timestamp at time zone 'America/Sao_Paulo'
      and (filter_category is null or category=filter_category)
  ), totals as (
    select category,unit,sum(quantity)::text as quantity from eligible group by category,unit
  ), page as (
    select * from eligible order by discarded_at desc,id limit page_size offset page_offset
  ), details as (
    select entry.id,entry.category,entry.quantity::text as quantity,entry.unit,entry.lot_status,
      lot.internal_code,location.code as location_code,item.original_code,
      coalesce(item.commercial_description,item.original_description) as description,
      reason.name as reason,destination.name as destination,entry.notes,entry.discarded_at,
      actor.display_name as operator
    from page entry join public.inventory_lots lot on lot.id=entry.lot_id
    join public.items item on item.id=lot.item_id
    join public.locations location on location.id=entry.location_id
    join public.loss_reasons reason on reason.id=entry.reason_id
    join public.loss_destinations destination on destination.id=entry.destination_id
    join public.profiles actor on actor.id=entry.discarded_by
  )
  select jsonb_build_object('total',(select count(*) from eligible),
    'totals',coalesce((select jsonb_agg(to_jsonb(totals) order by category,unit) from totals),'[]'::jsonb),
    'rows',coalesce((select jsonb_agg(to_jsonb(details) order by discarded_at desc,id) from details),'[]'::jsonb))
    into result;
  return result;
end
$$;

create function public.discard_stock(input jsonb,request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.discard_stock(input,request_id)
$$;
create function public.stock_waste_history(from_day date,to_day date,filter_category text,page_size int,page_offset int)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.stock_waste_history(from_day,to_day,filter_category,page_size,page_offset)
$$;
revoke all on function purezza_private.discard_stock(jsonb,uuid),public.discard_stock(jsonb,uuid),
  purezza_private.stock_waste_history(date,date,text,int,int),public.stock_waste_history(date,date,text,int,int)
  from public,anon,authenticated;
grant execute on function purezza_private.discard_stock(jsonb,uuid),public.discard_stock(jsonb,uuid),
  purezza_private.stock_waste_history(date,date,text,int,int),public.stock_waste_history(date,date,text,int,int)
  to authenticated;
