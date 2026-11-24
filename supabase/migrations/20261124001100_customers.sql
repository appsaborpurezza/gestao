create function purezza_private.valid_customer_document(kind text, doc text)
returns boolean language plpgsql immutable strict set search_path = '' as $$
declare
  weights int[];
  base_size int;
  step int;
  position int;
  remainder int;
  digit int;
begin
  if doc ~ '^(.)\1+$' then return false; end if;
  if kind = 'PF' and doc ~ '^[0-9]{11}$' then
    base_size := 9;
  elsif kind = 'PJ' and doc ~ '^[A-Z0-9]{12}[0-9]{2}$' then
    base_size := 12;
  else
    return false;
  end if;

  for step in 0..1 loop
    if kind = 'PF' then
      weights := array(select generate_series(10 + step, 2, -1));
    elsif step = 0 then
      weights := array[5,4,3,2,9,8,7,6,5,4,3,2];
    else
      weights := array[6,5,4,3,2,9,8,7,6,5,4,3,2];
    end if;
    remainder := 0;
    for position in 1..(base_size + step) loop
      remainder := remainder + (ascii(substr(doc, position, 1)) - 48) * weights[position];
    end loop;
    remainder := remainder % 11;
    digit := case when remainder < 2 then 0 else 11 - remainder end;
    if digit <> substr(doc, base_size + step + 1, 1)::int then return false; end if;
  end loop;
  return true;
end
$$;
revoke all on function purezza_private.valid_customer_document(text,text) from public, anon, authenticated;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  customer_number bigint generated always as identity unique,
  kind text not null check (kind in ('PF','PJ')),
  legal_name text not null check (length(btrim(legal_name)) between 1 and 180),
  trade_name text,
  document text unique check (document is null or purezza_private.valid_customer_document(kind, document)),
  state_registration text,
  street text,
  address_number text,
  complement text,
  district text,
  city text,
  uf text check (uf in ('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')),
  postal_code text check (postal_code ~ '^[0-9]{8}$'),
  phone text,
  whatsapp text,
  email text check (length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  contact_name text,
  payment_terms text,
  payment_days int check (payment_days between 0 and 3650),
  notes text check (length(notes) <= 3000),
  active boolean not null default true,
  version int not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  created_by uuid not null references public.profiles,
  updated_at timestamptz not null default statement_timestamp(),
  updated_by uuid not null references public.profiles
);
create index customers_name_idx on public.customers(legal_name, customer_number);

alter table public.customers enable row level security;
revoke all on public.customers from public, anon, authenticated;
grant select on public.customers to authenticated;
create policy customers_commercial_read on public.customers for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR','VENDAS')));

create function purezza_private.save_customer(target_customer uuid, expected_version int, input jsonb, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  fields public.customers%rowtype;
  normalized jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','VENDAS') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode salvar clientes.';
  end if;
  if jsonb_typeof(input) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Informe os dados do cliente.';
  end if;

  result_id := purezza_private.claim_operation('SALVAR_CLIENTE', request_id,
    to_jsonb(encode(sha256(convert_to(jsonb_build_array(target_customer, expected_version, input)::text, 'UTF8')), 'hex')));
  if result_id is not null then return result_id; end if;

  select jsonb_object_agg(key, case when jsonb_typeof(value) = 'string'
    then to_jsonb(nullif(btrim(value #>> '{}'), '')) else value end)
    into normalized from jsonb_each(input);
  select * into fields from jsonb_populate_record(null::public.customers, normalized);
  fields.document := nullif(upper(regexp_replace(fields.document, '[./[:space:]-]', '', 'g')), '');
  fields.postal_code := nullif(regexp_replace(fields.postal_code, '[-[:space:]]', '', 'g'), '');
  fields.uf := upper(fields.uf);
  if fields.document is not null and not coalesce(purezza_private.valid_customer_document(fields.kind, fields.document), false) then
    raise exception using errcode = '22023', message = 'CPF ou CNPJ inválido para o tipo de cliente.';
  end if;

  if target_customer is null then
    insert into public.customers(kind, legal_name, trade_name, document, state_registration, street, address_number,
      complement, district, city, uf, postal_code, phone, whatsapp, email, contact_name,
      payment_terms, payment_days, notes, active, created_by, updated_by)
    values(fields.kind, fields.legal_name, fields.trade_name, fields.document, fields.state_registration, fields.street,
      fields.address_number, fields.complement, fields.district, fields.city, fields.uf, fields.postal_code, fields.phone,
      fields.whatsapp, fields.email, fields.contact_name, fields.payment_terms, fields.payment_days, fields.notes,
      coalesce(fields.active,true), auth.uid(), auth.uid())
    returning id into result_id;
  else
    update public.customers set
      kind = fields.kind, legal_name = fields.legal_name, trade_name = fields.trade_name, document = fields.document,
      state_registration = fields.state_registration, street = fields.street, address_number = fields.address_number,
      complement = fields.complement, district = fields.district, city = fields.city, uf = fields.uf,
      postal_code = fields.postal_code, phone = fields.phone, whatsapp = fields.whatsapp, email = fields.email,
      contact_name = fields.contact_name, payment_terms = fields.payment_terms, payment_days = fields.payment_days,
      notes = fields.notes, active = coalesce(fields.active, active), version = version + 1,
      updated_at = statement_timestamp(), updated_by = auth.uid()
    where id = target_customer and version = expected_version
    returning id into result_id;
    if result_id is null then
      raise exception using errcode = '40001', message = 'O cadastro mudou. Reabra o cliente antes de salvar.';
    end if;
  end if;
  insert into public.audit_logs(actor, action, details)
    values(auth.uid(), 'SALVAR_CLIENTE', jsonb_build_object('cliente_id', result_id, 'criacao', target_customer is null));
  update public.operation_requests set result = result_id
    where actor = auth.uid() and operation = 'SALVAR_CLIENTE' and operation_requests.request_id = save_customer.request_id;
  return result_id;
end
$$;

create function public.save_customer(target_customer uuid, expected_version int, input jsonb, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.save_customer(target_customer, expected_version, input, request_id)
$$;
revoke all on function purezza_private.save_customer(uuid,int,jsonb,uuid), public.save_customer(uuid,int,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function purezza_private.save_customer(uuid,int,jsonb,uuid), public.save_customer(uuid,int,jsonb,uuid)
  to authenticated;
