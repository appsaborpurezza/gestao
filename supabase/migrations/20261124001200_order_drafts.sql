create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity unique,
  customer_id uuid not null references public.customers,
  customer_name text not null,
  seller_id uuid not null references public.profiles,
  issued_at timestamptz not null default statement_timestamp(),
  delivery_date date,
  operational_notes text check (length(operational_notes) <= 3000),
  fulfillment_status text not null default 'RASCUNHO' check (fulfillment_status = 'RASCUNHO')
);
create index orders_customer_idx on public.orders(customer_id);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders,
  item_id uuid not null references public.items,
  line_number int not null check (line_number > 0),
  item_code text not null,
  description text not null,
  unit text not null check (unit in ('kg','g','L','mL','un')),
  quantity numeric(18,6) not null check (quantity > 0 and quantity <> 'NaN'::numeric),
  kg_per_unit numeric(18,6) check (kg_per_unit > 0),
  unique (order_id, line_number),
  unique (order_id, item_id)
);
create index order_items_catalog_idx on public.order_items(item_id);

create table public.order_financials (
  order_id uuid primary key references public.orders,
  billing_status text not null default 'NAO_FATURADO' check (billing_status = 'NAO_FATURADO'),
  payment_terms text check (length(payment_terms) <= 254),
  payment_due_date date,
  commercial_notes text check (length(commercial_notes) <= 3000),
  total numeric(18,2) not null check (total >= 0 and total <> 'NaN'::numeric)
);
create table public.order_item_financials (
  order_item_id uuid primary key references public.order_items,
  unit_price numeric(18,2) not null check (unit_price >= 0 and unit_price <> 'NaN'::numeric),
  discount numeric(18,2) not null check (discount >= 0 and discount <> 'NaN'::numeric),
  total numeric(18,2) not null check (total >= 0 and total <> 'NaN'::numeric)
);

do $$
declare relation text;
begin
  foreach relation in array array['orders','order_items','order_financials','order_item_financials'] loop
    execute format('alter table public.%I enable row level security', relation);
    execute format('revoke all on public.%I from public, anon, authenticated', relation);
    execute format('grant select on public.%I to authenticated', relation);
    execute format('create policy order_commercial_read on public.%I for select to authenticated
      using ((select purezza_private.has_role(''ADMINISTRADOR'',''VENDAS'')))', relation);
  end loop;
end
$$;

create function purezza_private.create_order_draft(input jsonb, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  draft uuid;
  line_id uuid;
  client public.customers%rowtype;
  product public.items%rowtype;
  delivery date;
  due_date date;
  today date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
  line jsonb;
  ordinal int;
  amount numeric;
  price numeric;
  discount_amount numeric;
  line_total numeric;
  grand_total numeric := 0;
begin
  if not purezza_private.has_role('ADMINISTRADOR','VENDAS') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode criar pedidos.';
  end if;
  if jsonb_typeof(input) is distinct from 'object' or jsonb_typeof(input->'items') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Informe os dados e os itens do pedido.';
  end if;
  if jsonb_array_length(input->'items') not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Inclua de 1 a 100 itens no pedido.';
  end if;

  draft := purezza_private.claim_operation('CRIAR_RASCUNHO_PEDIDO', request_id,
    to_jsonb(encode(sha256(convert_to(input::text, 'UTF8')), 'hex')));
  if draft is not null then return draft; end if;

  delivery := nullif(input->>'delivery_date','')::date;
  due_date := nullif(input->>'payment_due_date','')::date;
  if delivery < today or due_date < today or (delivery is not null and not isfinite(delivery))
    or (due_date is not null and not isfinite(due_date)) then
    raise exception using errcode = '22023', message = 'Confira as datas de entrega e vencimento.';
  end if;

  select * into client from public.customers where id = (input->>'customer_id')::uuid and active for share;
  if not found then raise exception using errcode = '22023', message = 'Selecione um cliente ativo.'; end if;

  if exists (
    select from jsonb_array_elements(input->'items') as source(entry)
    group by (entry->>'item_id')::uuid having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Use uma única linha por item.';
  end if;

  insert into public.orders(customer_id, customer_name, seller_id, delivery_date, operational_notes)
    values(client.id, client.legal_name, auth.uid(), delivery, nullif(btrim(input->>'operational_notes'), ''))
    returning id into draft;

  for line, ordinal in
    select entry, position from jsonb_array_elements(input->'items') with ordinality as source(entry, position)
      order by entry->>'item_id'
  loop
    select * into product from public.items where id = (line->>'item_id')::uuid and active for share;
    if not found or product.base_unit is null or product.classification = 'INSUMO'
      or line->>'unit' is distinct from product.base_unit then
      raise exception using errcode = '22023', message = 'Selecione um produto ativo com unidade base cadastrada.';
    end if;

    amount := (line->>'quantity')::numeric;
    price := (line->>'unit_price')::numeric;
    discount_amount := coalesce((line->>'discount')::numeric, 0);
    if amount is null or not (amount > 0 and amount < 1000000000000)
      or amount <> round(amount, 6) or (product.base_unit = 'un' and amount <> trunc(amount))
      or price is null or not (price >= 0 and price < 10000000000000000) or price <> round(price, 2)
      or not (discount_amount >= 0 and discount_amount < 10000000000000000)
      or discount_amount <> round(discount_amount, 2) then
      raise exception using errcode = '22023', message = 'Confira quantidade, preço e desconto do item.';
    end if;
    line_total := round(amount * price, 2) - discount_amount;
    if line_total < 0 or line_total >= 10000000000000000 then
      raise exception using errcode = '22023', message = 'O total do item está fora do intervalo permitido.';
    end if;

    insert into public.order_items(order_id,item_id,line_number,item_code,description,unit,quantity,kg_per_unit)
      values(draft,product.id,ordinal,product.original_code,coalesce(product.commercial_description,product.original_description),
        product.base_unit,amount,case product.base_unit when 'kg' then 1 when 'g' then 0.001 end)
      returning id into line_id;
    insert into public.order_item_financials values(line_id, price, discount_amount, line_total);
    grand_total := grand_total + line_total;
  end loop;

  insert into public.order_financials(order_id,payment_terms,payment_due_date,commercial_notes,total)
    values(draft,nullif(btrim(input->>'payment_terms'), ''),due_date,
      nullif(btrim(input->>'commercial_notes'), ''),grand_total);
  insert into public.audit_logs(actor,action,details)
    values(auth.uid(),'CRIAR_RASCUNHO_PEDIDO',jsonb_build_object('pedido_id',draft));
  update public.operation_requests set result = draft
    where actor = auth.uid() and operation = 'CRIAR_RASCUNHO_PEDIDO'
      and operation_requests.request_id = create_order_draft.request_id;
  return draft;
end
$$;

create function public.create_order_draft(input jsonb, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.create_order_draft(input, request_id)
$$;

revoke all on function purezza_private.create_order_draft(jsonb,uuid), public.create_order_draft(jsonb,uuid)
  from public, anon, authenticated;
grant execute on function purezza_private.create_order_draft(jsonb,uuid), public.create_order_draft(jsonb,uuid)
  to authenticated;
