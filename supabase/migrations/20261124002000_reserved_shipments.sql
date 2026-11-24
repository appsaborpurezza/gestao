alter table public.stock_reservations add column dispatched_quantity numeric(18,6) not null default 0
  check (dispatched_quantity >= 0 and dispatched_quantity <= quantity);

alter table public.stock_movements drop constraint stock_movements_kind_check;
alter table public.stock_movements add constraint stock_movements_kind_check
  check (kind in ('RECEBIMENTO','TRANSFERENCIA','AJUSTE_INVENTARIO','ABERTURA_INVENTARIO','EXPEDICAO'));

alter table public.orders drop constraint orders_fulfillment_status_check;
alter table public.orders drop constraint orders_confirmation_metadata_check;
alter table public.orders add constraint orders_fulfillment_status_check
  check (fulfillment_status in ('RASCUNHO','CONFIRMADO','PARCIAL','EXPEDIDO'));
alter table public.orders add constraint orders_confirmation_metadata_check
  check ((fulfillment_status = 'RASCUNHO' and confirmed_at is null and confirmed_by is null)
    or (fulfillment_status in ('CONFIRMADO','PARCIAL','EXPEDIDO') and confirmed_at is not null and confirmed_by is not null));

create table public.shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders,
  reservation_id uuid not null references public.stock_reservations,
  stock_movement_id uuid not null unique references public.stock_movements,
  quantity numeric(18,6) not null check (quantity > 0 and quantity <> 'NaN'::numeric),
  method text not null check (method in ('ENTREGA','RETIRADA')),
  notes text check (length(notes) <= 500),
  dispatched_by uuid not null references public.profiles,
  dispatched_at timestamptz not null default statement_timestamp()
);
create index shipments_order_idx on public.shipments(order_id,dispatched_at);
create index shipments_reservation_idx on public.shipments(reservation_id);

alter table public.shipments enable row level security;
revoke all on public.shipments from public, anon, authenticated;
grant select on public.shipments to authenticated;
create policy shipments_read on public.shipments for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR','PRODUCAO','VENDAS')));

create function purezza_private.confirm_shipment(target_reservation uuid, amount numeric, method text, notes text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  shipment_id uuid := gen_random_uuid();
  movement_id uuid;
  purchase public.orders%rowtype;
  reservation public.stock_reservations%rowtype;
  lot public.inventory_lots%rowtype;
  ordered_unit text;
  cutoff date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
  order_complete boolean;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode confirmar expedições.';
  end if;
  previous := purezza_private.claim_operation('EXPEDIR_RESERVA',request_id,
    jsonb_build_array(target_reservation,amount,method,notes));
  if previous is not null then return previous; end if;

  select * into purchase from public.orders where id = (
    select entry.order_id from public.stock_reservations res
    join public.order_items entry on entry.id = res.order_item_id where res.id = target_reservation
  ) for update;
  if not found or purchase.fulfillment_status not in ('CONFIRMADO','PARCIAL') then
    raise exception using errcode = '22023', message = 'Selecione uma reserva de pedido em atendimento.';
  end if;
  select * into strict lot from public.inventory_lots where id = (
    select lot_id from public.stock_reservations where id = target_reservation
  ) for update;
  select * into strict reservation from public.stock_reservations where id = target_reservation for update;
  select unit into strict ordered_unit from public.order_items where id = reservation.order_item_id;
  cutoff := greatest(cutoff,purchase.delivery_date);
  if reservation.released_at is not null or amount is null
    or not (amount > 0 and amount <= reservation.quantity - reservation.dispatched_quantity)
    or amount <> round(amount,6) or (ordered_unit = 'un' and amount <> trunc(amount))
    or method is null or method not in ('ENTREGA','RETIRADA') then
    raise exception using errcode = '22023', message = 'Confira a modalidade e a quantidade ainda reservada.';
  end if;
  if lot.status <> 'LIBERADO' or lot.unit <> ordered_unit or not (
    lot.expiry = 'NAO_APLICAVEL' or (lot.expiry = 'INFORMADA' and lot.expires_on > cutoff)
  ) then
    raise exception using errcode = '22023', message = 'O lote não está elegível para expedição.';
  end if;
  perform id from public.locations where id = reservation.location_id and active for share;
  if not found then raise exception using errcode = '22023', message = 'O local da reserva está inativo.'; end if;

  update public.stock_reservations set dispatched_quantity = dispatched_quantity + amount
    where id = target_reservation;
  update public.stock_balances set quantity = quantity - amount
    where lot_id = reservation.lot_id and location_id = reservation.location_id and quantity >= amount;
  if not found then raise exception using errcode = '22023', message = 'Saldo físico insuficiente para expedição.'; end if;

  insert into public.stock_movements(lot_id,location_id,quantity_delta,kind,actor,correlation_id)
    values(reservation.lot_id,reservation.location_id,-amount,'EXPEDICAO',auth.uid(),shipment_id)
    returning id into movement_id;
  insert into public.shipments(id,order_id,reservation_id,stock_movement_id,quantity,method,notes,dispatched_by)
    values(shipment_id,purchase.id,target_reservation,movement_id,amount,method,nullif(btrim(notes),''),auth.uid());

  select not exists(
    select from public.order_items entry where entry.order_id = purchase.id
      and entry.quantity > (select coalesce(sum(res.dispatched_quantity),0) from public.stock_reservations res
        where res.order_item_id = entry.id)
  ) into order_complete;
  update public.orders set fulfillment_status = case when order_complete then 'EXPEDIDO' else 'PARCIAL' end,
    version = version + 1 where id = purchase.id;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'EXPEDIR_RESERVA',
    jsonb_build_object('pedido_id',purchase.id,'expedicao_id',shipment_id));
  update public.operation_requests set result = shipment_id
    where actor = auth.uid() and operation = 'EXPEDIR_RESERVA' and operation_requests.request_id = confirm_shipment.request_id;
  return shipment_id;
end
$$;

create function public.confirm_shipment(target_reservation uuid, amount numeric, method text, notes text, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.confirm_shipment(target_reservation,amount,method,notes,request_id)
$$;
revoke all on function purezza_private.confirm_shipment(uuid,numeric,text,text,uuid),
  public.confirm_shipment(uuid,numeric,text,text,uuid) from public, anon, authenticated;
grant execute on function purezza_private.confirm_shipment(uuid,numeric,text,text,uuid),
  public.confirm_shipment(uuid,numeric,text,text,uuid) to authenticated;

create function purezza_private.shipping_queue(page_size int, page_offset int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare report jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode acessar a fila de expedição.';
  end if;
  if page_size is null or page_size not between 1 and 100 or page_offset is null or page_offset < 0 then
    raise exception using errcode = '22023', message = 'Confira a paginação.';
  end if;
  with queue as (
    select res.id, purchase.order_number, purchase.customer_name, purchase.delivery_date, entry.description,
      entry.unit, lot.internal_code, location.code as location_code,
      (res.quantity - res.dispatched_quantity)::text as remaining,
      (lot.status = 'LIBERADO' and location.active and (
        lot.expiry = 'NAO_APLICAVEL' or (lot.expiry = 'INFORMADA' and lot.expires_on >
          greatest(purchase.delivery_date,(statement_timestamp() at time zone 'America/Sao_Paulo')::date))
      )) as eligible
    from public.stock_reservations res
    join public.order_items entry on entry.id = res.order_item_id
    join public.orders purchase on purchase.id = entry.order_id
    join public.inventory_lots lot on lot.id = res.lot_id
    join public.locations location on location.id = res.location_id
    where res.released_at is null and res.dispatched_quantity < res.quantity
      and purchase.fulfillment_status in ('CONFIRMADO','PARCIAL')
  ), page as (
    select * from queue order by delivery_date,order_number,id limit page_size offset page_offset
  )
  select jsonb_build_object('total',(select count(*) from queue),
    'rows',coalesce((select jsonb_agg(to_jsonb(page) order by delivery_date,order_number,id) from page),'[]'::jsonb)) into report;
  return report;
end
$$;
create function public.shipping_queue(page_size int, page_offset int)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.shipping_queue(page_size,page_offset)
$$;
revoke all on function purezza_private.shipping_queue(int,int), public.shipping_queue(int,int) from public, anon, authenticated;
grant execute on function purezza_private.shipping_queue(int,int), public.shipping_queue(int,int) to authenticated;

create or replace function purezza_private.guard_reserved_balance()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.quantity < old.quantity and new.quantity < (
    select coalesce(sum(quantity-dispatched_quantity),0) from public.stock_reservations
      where lot_id = new.lot_id and location_id = new.location_id and released_at is null
  ) then
    raise exception using errcode = '22023', message = 'A operação comprometeria saldo reservado neste local.';
  end if;
  return new;
end
$$;

create or replace function purezza_private.reserve_order_stock(target_line uuid, amount numeric, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  purchase public.orders%rowtype;
  line public.order_items%rowtype;
  slot record;
  rest numeric := amount;
  allocation numeric;
  first_reservation uuid;
  reservation_id uuid;
  eligible_lots uuid[];
  cutoff date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'A reserva exige perfil administrador.';
  end if;
  previous := purezza_private.claim_operation('RESERVAR_ESTOQUE_PEDIDO',request_id,
    jsonb_build_array(target_line,amount));
  if previous is not null then return previous; end if;

  select * into purchase from public.orders where id = (
    select order_id from public.order_items where id = target_line
  ) for update;
  if not found or purchase.fulfillment_status not in ('CONFIRMADO','PARCIAL') then
    raise exception using errcode = '22023', message = 'Selecione um item de pedido confirmado.';
  end if;
  select * into strict line from public.order_items where id = target_line and order_id = purchase.id;
  if line.confirmed_classification is null or line.confirmed_classification = 'FABRICACAO_PROPRIA' then
    raise exception using errcode = '22023', message = 'Este fluxo atende somente itens de terceiros ou revenda.';
  end if;
  if amount is null or not (amount > 0 and amount <= line.quantity)
    or amount <> round(amount,6) or (line.unit = 'un' and amount <> trunc(amount))
    or amount > line.quantity - (select coalesce(sum(case when released_at is null then quantity else dispatched_quantity end),0) from public.stock_reservations
      where order_item_id = target_line) then
    raise exception using errcode = '22023', message = 'Confira a quantidade ainda não reservada neste item.';
  end if;
  perform id from public.items where id = line.item_id and active for share;
  if not found then raise exception using errcode = '22023', message = 'O produto precisa estar ativo.'; end if;

  cutoff := greatest(cutoff,purchase.delivery_date);

  -- Lock lot rows first, in a common order, then calculate quantities from committed reservations.
  select array(select id from public.inventory_lots where item_id = line.item_id and unit = line.unit
    and status = 'LIBERADO' and (expiry = 'NAO_APLICAVEL' or (expiry = 'INFORMADA' and expires_on > cutoff))
    order by id for update) into eligible_lots;
  for slot in
    select lot.id lot_id, balance.location_id, balance.quantity - coalesce((
      select sum(quantity-dispatched_quantity) from public.stock_reservations where lot_id = lot.id
        and location_id = balance.location_id and released_at is null
    ),0) as available
    from public.inventory_lots lot
    join public.stock_balances balance on balance.lot_id = lot.id
    join public.locations location on location.id = balance.location_id and location.active
    left join public.receipts receipt on receipt.id = lot.receipt_id
    where lot.id = any(eligible_lots) and lot.status = 'LIBERADO'
      and (lot.expiry = 'NAO_APLICAVEL' or (lot.expiry = 'INFORMADA' and lot.expires_on > cutoff))
      and balance.quantity > 0
    order by lot.expires_on nulls last, coalesce(receipt.received_at,lot.opened_at),lot.id,balance.location_id
    for share of location
  loop
    if slot.available <= 0 then continue; end if;
    allocation := least(rest,slot.available);
    insert into public.stock_reservations(order_item_id,lot_id,location_id,quantity,reserved_by)
      values(target_line,slot.lot_id,slot.location_id,allocation,auth.uid()) returning id into reservation_id;
    first_reservation := coalesce(first_reservation,reservation_id);
    rest := rest - allocation;
    exit when rest = 0;
  end loop;
  if rest <> 0 then
    raise exception using errcode = '22023', message = 'Saldo elegível insuficiente para reservar essa quantidade.';
  end if;

  insert into public.audit_logs(actor,action,details) values(auth.uid(),'RESERVAR_ESTOQUE_PEDIDO',
    jsonb_build_object('item_pedido_id',target_line,'quantidade',amount,'primeira_reserva_id',first_reservation));
  update public.operation_requests set result = first_reservation
    where actor = auth.uid() and operation = 'RESERVAR_ESTOQUE_PEDIDO'
      and operation_requests.request_id = reserve_order_stock.request_id;
  return first_reservation;
end
$$;

create or replace function purezza_private.release_stock_reservation(target_reservation uuid, reason text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  target_lot uuid;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'A liberação da reserva exige perfil administrador.';
  end if;
  previous := purezza_private.claim_operation('LIBERAR_RESERVA_ESTOQUE',request_id,
    jsonb_build_array(target_reservation,reason));
  if previous is not null then return previous; end if;
  if nullif(btrim(reason),'') is null or length(reason) > 500 then
    raise exception using errcode = '22023', message = 'Informe o motivo da liberação.';
  end if;
  select lot_id into target_lot from public.stock_reservations where id = target_reservation;
  perform id from public.inventory_lots where id = target_lot for update;
  update public.stock_reservations set released_at = statement_timestamp(), released_by = auth.uid(),
    release_reason = reason where id = target_reservation and released_at is null and dispatched_quantity < quantity;
  if not found then
    raise exception using errcode = '22023', message = 'Selecione uma reserva ativa.';
  end if;

  insert into public.audit_logs(actor,action,details) values(auth.uid(),'LIBERAR_RESERVA_ESTOQUE',
    jsonb_build_object('reserva_id',target_reservation));
  update public.operation_requests set result = target_reservation
    where actor = auth.uid() and operation = 'LIBERAR_RESERVA_ESTOQUE'
      and operation_requests.request_id = release_stock_reservation.request_id;
  return target_reservation;
end
$$;

create or replace function public.suggest_fefo_lots(target_item uuid, requested_quantity numeric)
returns table(lot_id uuid, location_id uuid, internal_code text, expires_on date, suggested_quantity numeric)
language sql stable set search_path = '' as $$
  with positions as (
    select lot.id, b.location_id, lot.internal_code, lot.expires_on, coalesce(r.received_at,lot.opened_at) as origin_at,
      b.quantity - coalesce((
        select sum(res.quantity-res.dispatched_quantity) from public.stock_reservations res
        where res.lot_id = lot.id and res.location_id = b.location_id and res.released_at is null
      ),0) as available
    from public.inventory_lots lot
    left join public.receipts r on r.id = lot.receipt_id
    join public.stock_balances b on b.lot_id = lot.id
    join public.locations loc on loc.id = b.location_id and loc.active
    join public.items item on item.id = lot.item_id and item.active
    where lot.item_id = target_item and lot.status = 'LIBERADO' and b.quantity > 0
      and (lot.expiry = 'NAO_APLICAVEL' or (lot.expiry = 'INFORMADA'
        and lot.expires_on > (statement_timestamp() at time zone 'America/Sao_Paulo')::date))
      and requested_quantity > 0 and requested_quantity < 1000000000000
  ), eligible as (
    select p.*, coalesce(sum(p.available) over (
      order by p.expires_on nulls last,p.origin_at,p.id,p.location_id
      rows between unbounded preceding and 1 preceding
    ),0) as covered
    from positions p where p.available > 0
  )
  select e.id,e.location_id,e.internal_code,e.expires_on,least(e.available,requested_quantity-e.covered)
  from eligible e where e.covered < requested_quantity
  order by e.expires_on nulls last,e.origin_at,e.id,e.location_id
$$;

create or replace function purezza_private.register_billing(target_order uuid, input jsonb, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  billing_id uuid;
  finance public.order_financials%rowtype;
  issue_date date;
  billed numeric;
  installment jsonb;
  ordinal int;
  due_date date;
  installment_value numeric;
  sum_installments numeric := 0;
  new_total numeric;
begin
  if not purezza_private.has_role('VENDAS') then
    raise exception using errcode = '42501', message = 'Somente Vendas pode registrar faturamento.';
  end if;
  if jsonb_typeof(input) is distinct from 'object'
    or jsonb_typeof(input->'installments') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Informe a nota externa e suas parcelas.';
  end if;
  if jsonb_array_length(input->'installments') not between 1 and 60 then
    raise exception using errcode = '22023', message = 'Informe de 1 a 60 parcelas.';
  end if;
  billing_id := purezza_private.claim_operation('REGISTRAR_FATURAMENTO', request_id,
    to_jsonb(encode(sha256(convert_to(jsonb_build_array(target_order,input)::text, 'UTF8')), 'hex')));
  if billing_id is not null then return billing_id; end if;

  perform id from public.orders where id = target_order and fulfillment_status in ('CONFIRMADO','PARCIAL','EXPEDIDO') for update;
  if not found then
    raise exception using errcode = '22023', message = 'Selecione um pedido confirmado.';
  end if;
  select * into strict finance from public.order_financials where order_id = target_order for update;

  issue_date := nullif(input->>'issued_on','')::date;
  billed := (input->>'amount')::numeric;
  if issue_date is null or not isfinite(issue_date)
    or issue_date > (statement_timestamp() at time zone 'America/Sao_Paulo')::date
    or billed is null or not (billed > 0 and billed <= finance.total - finance.billed_total)
    or billed <> round(billed, 2) then
    raise exception using errcode = '22023', message = 'Confira a emissão e o valor disponível para faturar.';
  end if;

  insert into public.billing_records(order_id, invoice_number, invoice_series, invoice_access_key, issued_on, amount, registered_by)
    values(target_order, btrim(input->>'invoice_number'), nullif(btrim(input->>'invoice_series'),''),
      nullif(regexp_replace(input->>'invoice_access_key','[[:space:]]','','g'),''), issue_date, billed, auth.uid())
    returning id into billing_id;

  for installment, ordinal in
    select entry, position from jsonb_array_elements(input->'installments') with ordinality as source(entry, position)
  loop
    due_date := nullif(installment->>'due_on','')::date;
    installment_value := (installment->>'amount')::numeric;
    if due_date is null or not isfinite(due_date) or due_date < issue_date
      or installment_value is null or not (installment_value > 0 and installment_value <= billed)
      or installment_value <> round(installment_value, 2) then
      raise exception using errcode = '22023', message = 'Confira o vencimento e o valor de cada parcela.';
    end if;
    sum_installments := sum_installments + installment_value;
    insert into public.billing_installments(billing_id,position,due_on,amount)
      values(billing_id,ordinal,due_date,installment_value);
  end loop;

  if sum_installments <> billed then
    raise exception using errcode = '22023', message = 'A soma das parcelas precisa coincidir com o valor faturado.';
  end if;
  new_total := finance.billed_total + billed;
  update public.order_financials set billed_total = new_total,
    billing_status = case when new_total = finance.total then 'FATURADO' else 'PARCIAL' end
    where order_id = target_order;

  insert into public.audit_logs(actor,action,details)
    values(auth.uid(),'REGISTRAR_FATURAMENTO',jsonb_build_object('pedido_id',target_order,'faturamento_id',billing_id));
  update public.operation_requests set result = billing_id
    where actor = auth.uid() and operation = 'REGISTRAR_FATURAMENTO'
      and operation_requests.request_id = register_billing.request_id;
  return billing_id;
end
$$;

create or replace function purezza_private.issue_commercial_document(target_order uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  purchase public.orders%rowtype;
  finance public.order_financials%rowtype;
  buyer public.customers%rowtype;
  company public.commercial_document_settings%rowtype;
  document public.commercial_documents%rowtype;
  document_data jsonb;
begin
  if not purezza_private.has_role('VENDAS') then
    raise exception using errcode = '42501', message = 'Somente Vendas pode emitir ou baixar este documento.';
  end if;

  select * into purchase from public.orders where id = target_order for update;
  if not found then raise exception using errcode = '22023', message = 'Pedido não encontrado.'; end if;

  select * into document from public.commercial_documents
    where order_id = target_order order by document_version desc limit 1;
  if not found then
    select * into finance from public.order_financials where order_id = target_order;
    if purchase.fulfillment_status not in ('CONFIRMADO','PARCIAL','EXPEDIDO') or finance.billing_status is distinct from 'FATURADO' then
      raise exception using errcode = '22023', message = 'O pedido precisa estar integralmente faturado.';
    end if;
    select * into strict buyer from public.customers where id = purchase.customer_id;
    select * into strict company from public.commercial_document_settings where id;

    document_data := jsonb_build_object(
      'order_number',purchase.order_number::text,
      'order_issued_on',((purchase.issued_at at time zone 'America/Sao_Paulo')::date)::text,
      'customer',jsonb_build_object(
        'name',purchase.customer_name,'street',buyer.street,'address_number',buyer.address_number,
        'complement',buyer.complement,'district',buyer.district,'city',buyer.city,'uf',buyer.uf,
        'postal_code',buyer.postal_code,'phone',coalesce(buyer.phone,buyer.whatsapp),'contact',buyer.contact_name,
        'document',buyer.document,'state_registration',buyer.state_registration
      ),
      'company',jsonb_build_object('name',company.company_name,'address',company.company_address,'phone',company.company_phone),
      'payment_terms',finance.payment_terms,
      'payment_due_date',finance.payment_due_date,
      'notes',finance.commercial_notes,
      'total',finance.total::text,
      'items',(
        select coalesce(jsonb_agg(jsonb_build_object('description',entry.description,'quantity',entry.quantity::text,
          'unit',entry.unit,'unit_price',values_.unit_price::text,'discount',values_.discount::text,
          'total',values_.total::text) order by entry.line_number),'[]'::jsonb)
        from public.order_items entry join public.order_item_financials values_ on values_.order_item_id = entry.id
        where entry.order_id = target_order
      ),
      'installments',(
        select coalesce(jsonb_agg(jsonb_build_object('due_on',installment.due_on,'amount',installment.amount::text)
          order by installment.due_on,billing.id,installment.position),'[]'::jsonb)
        from public.billing_records billing join public.billing_installments installment on installment.billing_id = billing.id
        where billing.order_id = target_order
      )
    );

    insert into public.commercial_documents(order_id,document_version,renderer_version,issued_by,snapshot,snapshot_hash)
      values(target_order,1,1,auth.uid(),document_data,encode(sha256(convert_to(document_data::text,'UTF8')),'hex'))
      returning * into document;
  end if;

  insert into public.audit_logs(actor,action,details) values(auth.uid(),'ACESSAR_DOCUMENTO_COMERCIAL',
    jsonb_build_object('pedido_id',target_order,'documento_id',document.id,'versao',document.document_version));
  return jsonb_build_object('snapshot',document.snapshot,'issued_at',document.issued_at,
    'snapshot_hash',document.snapshot_hash,'version',document.document_version,'renderer_version',document.renderer_version);
end
$$;
