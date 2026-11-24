alter table public.orders add column version int not null default 1 check (version > 0);

create function purezza_private.save_order_draft(target uuid, expected_version int, input jsonb, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  draft uuid;
  operation_name text := case when target is null then 'CRIAR_RASCUNHO_PEDIDO' else 'EDITAR_RASCUNHO_PEDIDO' end;
  request_payload text;
  line_id uuid;
  client public.customers%rowtype;
  product public.items%rowtype;
  delivery date;
  due_date date;
  existing_delivery date;
  existing_due date;
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
    raise exception using errcode = '42501', message = 'Seu perfil não pode salvar pedidos.';
  end if;
  if jsonb_typeof(input) is distinct from 'object' or jsonb_typeof(input->'items') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Informe os dados e os itens do pedido.';
  end if;
  if jsonb_array_length(input->'items') not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Inclua de 1 a 100 itens no pedido.';
  end if;

  request_payload := case when target is null then input::text
    else jsonb_build_array(target, expected_version, input)::text end;
  draft := purezza_private.claim_operation(operation_name, request_id,
    to_jsonb(encode(sha256(convert_to(request_payload, 'UTF8')), 'hex')));
  if draft is not null then return draft; end if;

  delivery := nullif(input->>'delivery_date','')::date;
  due_date := nullif(input->>'payment_due_date','')::date;
  if target is not null then
    select orders.delivery_date, finance.payment_due_date into existing_delivery, existing_due
      from public.orders orders join public.order_financials finance on finance.order_id = orders.id
      where orders.id = target and orders.version = expected_version;
  end if;
  if (delivery < today and delivery is distinct from existing_delivery)
    or (due_date < today and due_date is distinct from existing_due)
    or (delivery is not null and not isfinite(delivery))
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

  if target is null then
    insert into public.orders(customer_id, customer_name, seller_id, delivery_date, operational_notes)
      values(client.id, client.legal_name, auth.uid(), delivery, nullif(btrim(input->>'operational_notes'), ''))
      returning id into draft;
  else
    update public.orders set customer_id = client.id, customer_name = client.legal_name,
      delivery_date = delivery, operational_notes = nullif(btrim(input->>'operational_notes'), ''),
      version = version + 1
    where id = target and version = expected_version and fulfillment_status = 'RASCUNHO'
    returning id into draft;
    if draft is null then
      raise exception using errcode = '40001', message = 'O pedido mudou. Reabra um rascunho atualizado.';
    end if;

    -- Only draft lines can be replaced. Any subsequent validation error rolls this back.
    delete from public.order_item_financials
      where order_item_id in (select id from public.order_items where order_id = draft);
    delete from public.order_items where order_id = draft;
  end if;

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
      nullif(btrim(input->>'commercial_notes'), ''),grand_total)
    on conflict(order_id) do update set payment_terms = excluded.payment_terms,
      payment_due_date = excluded.payment_due_date, commercial_notes = excluded.commercial_notes, total = excluded.total;
  insert into public.audit_logs(actor,action,details)
    values(auth.uid(),operation_name,jsonb_build_object('pedido_id',draft));
  update public.operation_requests set result = draft
    where actor = auth.uid() and operation = operation_name
      and operation_requests.request_id = save_order_draft.request_id;
  return draft;
end
$$;

revoke all on function purezza_private.save_order_draft(uuid,int,jsonb,uuid) from public, anon, authenticated;

create or replace function purezza_private.create_order_draft(input jsonb, request_id uuid)
returns uuid language sql security definer set search_path = '' as $$
  select purezza_private.save_order_draft(null, null, input, request_id)
$$;

create function purezza_private.edit_order_draft(target_order uuid, expected_version int, input jsonb, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if target_order is null or expected_version is null then
    raise exception using errcode = '22023', message = 'Informe o rascunho e sua versão.';
  end if;
  return purezza_private.save_order_draft(target_order, expected_version, input, request_id);
end
$$;

create function public.edit_order_draft(target_order uuid, expected_version int, input jsonb, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.edit_order_draft(target_order, expected_version, input, request_id)
$$;
revoke all on function purezza_private.edit_order_draft(uuid,int,jsonb,uuid), public.edit_order_draft(uuid,int,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function purezza_private.edit_order_draft(uuid,int,jsonb,uuid), public.edit_order_draft(uuid,int,jsonb,uuid)
  to authenticated;
