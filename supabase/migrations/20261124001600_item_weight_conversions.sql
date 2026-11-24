alter table public.items add column unit_version int not null default 1 check (unit_version > 0);

create table public.item_unit_conversions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items,
  version int not null check (version > 0),
  source_unit text not null check (source_unit in ('un','L','mL')),
  kg_per_unit numeric(18,6) not null check (kg_per_unit > 0 and kg_per_unit <> 'NaN'::numeric),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  approved_by uuid not null references public.profiles,
  approved_at timestamptz not null default statement_timestamp(),
  unique (item_id, version)
);
alter table public.item_unit_conversions enable row level security;
revoke all on public.item_unit_conversions from public, anon, authenticated;
grant select on public.item_unit_conversions to authenticated;
create policy item_unit_conversions_technical_read on public.item_unit_conversions for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR','PRODUCAO')));

alter table public.order_items add column conversion_id uuid references public.item_unit_conversions;
create index order_items_conversion_idx on public.order_items(conversion_id) where conversion_id is not null;

create function purezza_private.configure_item_units(
  target_item uuid, expected_version int, base_unit text, factor numeric, reason text, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  item public.items%rowtype;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'A configuração de unidades exige perfil administrador.';
  end if;
  previous := purezza_private.claim_operation('CONFIGURAR_UNIDADE_ITEM', request_id,
    jsonb_build_array(target_item, expected_version, base_unit, factor, reason));
  if previous is not null then return previous; end if;
  if base_unit is null or base_unit not in ('kg','g','un','L','mL')
    or nullif(btrim(reason), '') is null or length(btrim(reason)) > 500
    or (factor is not null and (base_unit in ('kg','g') or not (factor > 0 and factor < 1000000000000)
        or factor <> round(factor, 6))) then
    raise exception using errcode = '22023', message = 'Confira a unidade, o fator em kg e a justificativa.';
  end if;

  select * into item from public.items where id = target_item for update;
  if not found or item.unit_version is distinct from expected_version then
    raise exception using errcode = '40001', message = 'A configuração mudou. Atualize a consulta.';
  end if;
  if item.base_unit is distinct from base_unit and (
    exists(select from public.inventory_lots where item_id = target_item)
    or exists(select from public.order_items where item_id = target_item and confirmed_classification is not null)
  ) then
    raise exception using errcode = '22023', message = 'A unidade base está vinculada a lote ou pedido confirmado.';
  end if;

  update public.items set base_unit = configure_item_units.base_unit, unit_version = item.unit_version + 1
    where id = target_item;
  if factor is not null then
    insert into public.item_unit_conversions(item_id,version,source_unit,kg_per_unit,reason,approved_by)
      values(target_item,item.unit_version + 1,base_unit,factor,btrim(reason),auth.uid());
  end if;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'CONFIGURAR_UNIDADE_ITEM',
    jsonb_build_object('item_id',target_item,'unidade_anterior',item.base_unit,'unidade',base_unit,
      'versao',item.unit_version + 1,'motivo',btrim(reason)));
  update public.operation_requests set result = target_item
    where actor = auth.uid() and operation = 'CONFIGURAR_UNIDADE_ITEM'
      and operation_requests.request_id = configure_item_units.request_id;
  return target_item;
end
$$;

create function purezza_private.checked_demand_kg(quantity numeric, factor numeric)
returns numeric language plpgsql immutable strict set search_path = '' as $$
declare
  weight numeric := quantity * factor;
begin
  if weight >= 1000000000000 or weight <> round(weight, 9) then
    raise exception using errcode = '22023', message = 'A conversão excede a faixa ou a precisão de peso do pedido.';
  end if;
  return weight;
end
$$;
revoke all on function purezza_private.checked_demand_kg(numeric,numeric) from public, anon, authenticated;

create function purezza_private.snapshot_order_item_weight()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.kg_per_unit is null then
    select conversion.id, conversion.kg_per_unit into new.conversion_id, new.kg_per_unit
    from public.item_unit_conversions conversion
    join public.items item on item.id = conversion.item_id and item.unit_version = conversion.version
    where item.id = new.item_id and conversion.source_unit = new.unit;
  end if;
  if new.confirmed_classification = 'FABRICACAO_PROPRIA' then
    perform purezza_private.checked_demand_kg(new.quantity, new.kg_per_unit);
  end if;
  return new;
end
$$;
revoke all on function purezza_private.snapshot_order_item_weight() from public, anon, authenticated;
create trigger snapshot_order_item_weight before insert or update of confirmed_classification on public.order_items
  for each row execute function purezza_private.snapshot_order_item_weight();

create function purezza_private.resolve_demand_weight(target_demand uuid, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  demand public.production_demands%rowtype;
  item public.items%rowtype;
  conversion public.item_unit_conversions%rowtype;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode atualizar a demanda.';
  end if;
  previous := purezza_private.claim_operation('RESOLVER_PESO_DEMANDA', request_id, jsonb_build_array(target_demand));
  if previous is not null then return previous; end if;

  select * into demand from public.production_demands where order_item_id = target_demand for update;
  if not found or demand.requested_kg is not null then
    raise exception using errcode = '22023', message = 'Selecione uma demanda com conversão pendente.';
  end if;
  select * into item from public.items where id = demand.item_id and active for share;
  select * into conversion from public.item_unit_conversions
    where item_id = item.id and version = item.unit_version and source_unit = demand.unit;
  if not found then
    raise exception using errcode = '22023', message = 'O produto ainda não tem conversão aprovada para esta unidade.';
  end if;

  update public.order_items set kg_per_unit = conversion.kg_per_unit, conversion_id = conversion.id
    where id = target_demand and kg_per_unit is null;
  if not found then
    raise exception using errcode = '40001', message = 'O peso da linha mudou. Atualize a consulta.';
  end if;
  update public.production_demands
    set requested_kg = purezza_private.checked_demand_kg(quantity, conversion.kg_per_unit)
    where order_item_id = target_demand;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'RESOLVER_PESO_DEMANDA',
    jsonb_build_object('demanda_id',target_demand,'conversao_id',conversion.id));
  update public.operation_requests set result = target_demand
    where actor = auth.uid() and operation = 'RESOLVER_PESO_DEMANDA'
      and operation_requests.request_id = resolve_demand_weight.request_id;
  return target_demand;
end
$$;

create function public.configure_item_units(
  target_item uuid, expected_version int, base_unit text, factor numeric, reason text, request_id uuid
)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.configure_item_units(target_item, expected_version, base_unit, factor, reason, request_id)
$$;
create function public.resolve_demand_weight(target_demand uuid, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.resolve_demand_weight(target_demand, request_id)
$$;
revoke all on function purezza_private.configure_item_units(uuid,int,text,numeric,text,uuid),
  public.configure_item_units(uuid,int,text,numeric,text,uuid), purezza_private.resolve_demand_weight(uuid,uuid),
  public.resolve_demand_weight(uuid,uuid) from public, anon, authenticated;
grant execute on function purezza_private.configure_item_units(uuid,int,text,numeric,text,uuid),
  public.configure_item_units(uuid,int,text,numeric,text,uuid), purezza_private.resolve_demand_weight(uuid,uuid),
  public.resolve_demand_weight(uuid,uuid) to authenticated;
