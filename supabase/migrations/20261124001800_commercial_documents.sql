create table public.commercial_document_settings (
  id boolean primary key default true check (id),
  company_name text not null check (length(btrim(company_name)) between 1 and 180),
  company_address text not null check (length(btrim(company_address)) between 1 and 300),
  company_phone text not null check (length(btrim(company_phone)) between 1 and 100),
  version int not null default 1 check (version > 0)
);

insert into public.commercial_document_settings(company_name,company_address,company_phone)
values ('Sabor Purezza Massas', 'Rua Sinceridade, 99 - Jardim da Paz, Americana/SP, CEP 13470-487',
  '(19) 3407-3111 / (19) 99784-4790');

create table public.commercial_documents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders,
  document_version int not null check (document_version > 0),
  renderer_version int not null check (renderer_version > 0),
  issued_at timestamptz not null default statement_timestamp(),
  issued_by uuid not null references public.profiles,
  snapshot jsonb not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  unique (order_id, document_version)
);

alter table public.commercial_document_settings enable row level security;
alter table public.commercial_documents enable row level security;
revoke all on public.commercial_document_settings, public.commercial_documents from public, anon, authenticated;
grant select on public.commercial_document_settings, public.commercial_documents to authenticated;
create policy commercial_settings_admin_read on public.commercial_document_settings for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR')));
create policy commercial_document_sales_read on public.commercial_documents for select to authenticated
  using ((select purezza_private.has_role('VENDAS')));

create function purezza_private.configure_commercial_document(
  expected_version int, input jsonb, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  changed_id uuid;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'A configuração exige perfil administrador.';
  end if;
  changed_id := purezza_private.claim_operation('CONFIGURAR_DOCUMENTO_COMERCIAL',request_id,
    jsonb_build_array(expected_version,input));
  if changed_id is not null then return changed_id; end if;
  update public.commercial_document_settings set
    company_name = btrim(input->>'company_name'), company_address = btrim(input->>'company_address'),
    company_phone = btrim(input->>'company_phone'), version = version + 1
    where id and version = expected_version;
  if not found then
    raise exception using errcode = '40001', message = 'A configuração mudou. Atualize a consulta.';
  end if;
  changed_id := gen_random_uuid();
  insert into public.audit_logs(actor,action,details)
    values(auth.uid(),'CONFIGURAR_DOCUMENTO_COMERCIAL',jsonb_build_object('versao',expected_version+1));
  update public.operation_requests set result = changed_id
    where actor = auth.uid() and operation = 'CONFIGURAR_DOCUMENTO_COMERCIAL'
      and operation_requests.request_id = configure_commercial_document.request_id;
  return changed_id;
end
$$;

create function purezza_private.issue_commercial_document(target_order uuid)
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
    if purchase.fulfillment_status <> 'CONFIRMADO' or finance.billing_status is distinct from 'FATURADO' then
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

create function public.configure_commercial_document(expected_version int, input jsonb, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.configure_commercial_document(expected_version,input,request_id)
$$;
create function public.issue_commercial_document(target_order uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select purezza_private.issue_commercial_document(target_order)
$$;
revoke all on function purezza_private.configure_commercial_document(int,jsonb,uuid),
  public.configure_commercial_document(int,jsonb,uuid), purezza_private.issue_commercial_document(uuid),
  public.issue_commercial_document(uuid) from public, anon, authenticated;
grant execute on function purezza_private.configure_commercial_document(int,jsonb,uuid),
  public.configure_commercial_document(int,jsonb,uuid), purezza_private.issue_commercial_document(uuid),
  public.issue_commercial_document(uuid) to authenticated;
