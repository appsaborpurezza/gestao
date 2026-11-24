alter table public.orders drop constraint orders_fulfillment_status_check;
alter table public.orders add constraint orders_fulfillment_status_check
  check (fulfillment_status in ('RASCUNHO','CONFIRMADO'));
alter table public.orders add column confirmed_at timestamptz;
alter table public.orders add column confirmed_by uuid references public.profiles;
alter table public.orders add constraint orders_confirmation_metadata_check
  check ((fulfillment_status = 'RASCUNHO' and confirmed_at is null and confirmed_by is null)
    or (fulfillment_status = 'CONFIRMADO' and confirmed_at is not null and confirmed_by is not null));

alter table public.order_items add column confirmed_classification text
  check (confirmed_classification in ('TERCEIRO','FABRICACAO_PROPRIA','REVENDA_A_VALIDAR','FARINHA_USO_REVENDA_A_VALIDAR'));

create table public.production_demands (
  order_item_id uuid primary key references public.order_items,
  order_id uuid not null references public.orders,
  order_number bigint not null,
  delivery_date date not null,
  customer_name text not null,
  item_id uuid not null references public.items,
  item_code text not null,
  description text not null,
  unit text not null,
  quantity numeric(18,6) not null check (quantity > 0),
  requested_kg numeric(21,9) check (requested_kg > 0),
  status text generated always as (
    case when requested_kg is null then 'PENDENTE_CONVERSAO' else 'AGUARDANDO_PLANEJAMENTO' end
  ) stored,
  created_at timestamptz not null default statement_timestamp()
);
create index production_demands_due_idx on public.production_demands(delivery_date, order_number, order_item_id);
create index production_demands_order_idx on public.production_demands(order_id);
create index production_demands_item_idx on public.production_demands(item_id);

alter table public.production_demands enable row level security;
revoke all on public.production_demands from public, anon, authenticated;
grant select on public.production_demands to authenticated;
create policy production_demands_operational_read on public.production_demands for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR','PRODUCAO')));

create function purezza_private.confirm_order(target_order uuid, expected_version int, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  draft public.orders%rowtype;
  line record;
  demand_count int;
begin
  if not purezza_private.has_role('ADMINISTRADOR','VENDAS') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode confirmar pedidos.';
  end if;
  previous := purezza_private.claim_operation('CONFIRMAR_PEDIDO', request_id,
    jsonb_build_array(target_order, expected_version));
  if previous is not null then return previous; end if;

  select * into draft from public.orders where id = target_order for update;
  if not found or draft.version is distinct from expected_version or draft.fulfillment_status <> 'RASCUNHO' then
    raise exception using errcode = '40001', message = 'O pedido mudou. Reabra um rascunho atualizado.';
  end if;
  if draft.delivery_date is null or draft.delivery_date < (statement_timestamp() at time zone 'America/Sao_Paulo')::date then
    raise exception using errcode = '22023', message = 'Informe uma data de entrega válida antes de confirmar.';
  end if;

  perform id from public.customers where id = draft.customer_id and active for share;
  if not found then raise exception using errcode = '22023', message = 'O cliente do pedido precisa estar ativo.'; end if;
  if not exists(select from public.order_items where order_id = target_order) then
    raise exception using errcode = '22023', message = 'O pedido precisa ter pelo menos um item.';
  end if;

  for line in
    select entry.id, entry.unit, product.active, product.classification, product.base_unit
    from public.order_items entry join public.items product on product.id = entry.item_id
    where entry.order_id = target_order order by product.id for share of product
  loop
    if not line.active or line.classification = 'INSUMO' or line.base_unit is distinct from line.unit then
      raise exception using errcode = '22023', message = 'Revise os produtos e as unidades do pedido antes de confirmar.';
    end if;
    update public.order_items set confirmed_classification = line.classification where id = line.id;
  end loop;

  insert into public.production_demands(order_item_id,order_id,order_number,delivery_date,customer_name,
    item_id,item_code,description,unit,quantity,requested_kg)
  select entry.id, draft.id, draft.order_number, draft.delivery_date, draft.customer_name,
    entry.item_id, entry.item_code, entry.description, entry.unit, entry.quantity, entry.quantity * entry.kg_per_unit
  from public.order_items entry
  where entry.order_id = target_order and entry.confirmed_classification = 'FABRICACAO_PROPRIA';
  get diagnostics demand_count = row_count;

  update public.orders set fulfillment_status = 'CONFIRMADO', confirmed_at = statement_timestamp(),
    confirmed_by = auth.uid(), version = version + 1 where id = target_order;
  insert into public.audit_logs(actor,action,details)
    values(auth.uid(),'CONFIRMAR_PEDIDO',jsonb_build_object('pedido_id',target_order,'demandas_internas',demand_count));
  update public.operation_requests set result = target_order
    where actor = auth.uid() and operation = 'CONFIRMAR_PEDIDO'
      and operation_requests.request_id = confirm_order.request_id;
  return target_order;
end
$$;

create function public.confirm_order(target_order uuid, expected_version int, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.confirm_order(target_order, expected_version, request_id)
$$;
revoke all on function purezza_private.confirm_order(uuid,int,uuid), public.confirm_order(uuid,int,uuid)
  from public, anon, authenticated;
grant execute on function purezza_private.confirm_order(uuid,int,uuid), public.confirm_order(uuid,int,uuid)
  to authenticated;
