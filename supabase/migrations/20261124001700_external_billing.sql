alter table public.order_financials drop constraint order_financials_billing_status_check;
alter table public.order_financials add column billed_total numeric(18,2) not null default 0;
alter table public.order_financials add constraint order_billing_totals_check
  check (billed_total >= 0 and billed_total <= total and (
    (billing_status = 'NAO_FATURADO' and billed_total = 0)
    or (billing_status = 'PARCIAL' and billed_total > 0 and billed_total < total)
    or (billing_status = 'FATURADO' and billed_total > 0 and billed_total = total)
  ));

create table public.billing_records (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders,
  invoice_number text not null check (length(btrim(invoice_number)) between 1 and 30),
  invoice_series text check (length(invoice_series) between 1 and 12),
  invoice_access_key text check (invoice_access_key ~ '^[0-9]{44}$'),
  issued_on date not null check (isfinite(issued_on)),
  amount numeric(18,2) not null check (amount > 0 and amount <> 'NaN'::numeric),
  registered_by uuid not null references public.profiles,
  registered_at timestamptz not null default statement_timestamp()
);
create unique index billing_unique_order_reference_idx on public.billing_records(order_id, invoice_number, coalesce(invoice_series,''));
create unique index billing_unique_order_key_idx on public.billing_records(order_id, invoice_access_key) where invoice_access_key is not null;

create table public.billing_installments (
  billing_id uuid not null references public.billing_records,
  position int not null check (position > 0),
  due_on date not null check (isfinite(due_on)),
  amount numeric(18,2) not null check (amount > 0 and amount <> 'NaN'::numeric),
  primary key (billing_id, position)
);

do $$
declare relation text;
begin
  foreach relation in array array['billing_records','billing_installments'] loop
    execute format('alter table public.%I enable row level security', relation);
    execute format('revoke all on public.%I from public, anon, authenticated', relation);
    execute format('grant select on public.%I to authenticated', relation);
    execute format('create policy billing_commercial_read on public.%I for select to authenticated
      using ((select purezza_private.has_role(''ADMINISTRADOR'',''VENDAS'')))', relation);
  end loop;
end
$$;

create function purezza_private.register_billing(target_order uuid, input jsonb, request_id uuid)
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

  perform id from public.orders where id = target_order and fulfillment_status = 'CONFIRMADO' for update;
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

create function public.register_billing(target_order uuid, input jsonb, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.register_billing(target_order, input, request_id)
$$;
revoke all on function purezza_private.register_billing(uuid,jsonb,uuid), public.register_billing(uuid,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function purezza_private.register_billing(uuid,jsonb,uuid), public.register_billing(uuid,jsonb,uuid)
  to authenticated;
