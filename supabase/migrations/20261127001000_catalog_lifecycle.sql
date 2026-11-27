-- Ciclo de vida dos cadastros mestres: prévia de dependências, exclusão segura,
-- inativação/reativação, histórico, cadastro de produtos e busca de semelhantes.
-- Incremental: não altera migrations anteriores, FKs, RLS nem dados existentes.
-- A decisão de excluir é sempre tomada aqui, dentro da transação, com a linha travada.

alter table public.loss_reasons add column if not exists version integer not null default 1 check (version > 0);
alter table public.loss_destinations add column if not exists version integer not null default 1 check (version > 0);

create index if not exists audit_logs_details_idx on public.audit_logs using gin (details jsonb_path_ops);

-- Entidades aceitas. Nenhum nome de tabela vem do front.
create function purezza_private.catalog_entity_ok(entity text)
returns boolean language sql immutable set search_path = '' as $$
  select entity in ('CLIENTE','PRODUTO','INSUMO','FORNECEDOR','FABRICANTE','LOCAL',
    'MOTIVO_PERDA','DESTINACAO_PERDA','VERSAO_RECEITA','CONFIG_EMBALAGEM')
$$;

-- Dependências que impedem exclusão definitiva (histórico e vínculos).
create function purezza_private.catalog_dependency_rows(entity text, record_id uuid)
returns table(type text, label text, count bigint)
language sql stable security definer set search_path = '' as $$
  select type, label, count from (
    select 'orders' type, 'Pedidos' label, (select count(*) from public.orders where customer_id = record_id) count where entity = 'CLIENTE'
    union all select 'recipe_assignments', 'Associações de receita', (select count(*) from public.customer_product_recipes where customer_id = record_id) where entity = 'CLIENTE'
    union all select 'order_items', 'Itens de pedido', (select count(*) from public.order_items where item_id = record_id) where entity in ('PRODUTO','INSUMO')
    union all select 'lots', 'Lotes', (select count(*) from public.inventory_lots where item_id = record_id) where entity in ('PRODUTO','INSUMO')
    union all select 'demands', 'Demandas de produção', (select count(*) from public.production_demands where item_id = record_id) where entity in ('PRODUTO','INSUMO')
    union all select 'recipe_assignments', 'Associações de receita', (select count(*) from public.customer_product_recipes where product_id = record_id) where entity in ('PRODUTO','INSUMO')
    union all select 'packaging', 'Configurações de embalagem', (select count(*) from public.product_packaging_configs
      where record_id in (product_id, package_item_id, label_item_id)) where entity in ('PRODUTO','INSUMO')
    union all select 'conversions', 'Conversões de unidade aprovadas', (select count(*) from public.item_unit_conversions where item_id = record_id) where entity in ('PRODUTO','INSUMO')
    union all select 'recipes', 'Ingredientes de receita', (select count(*) from public.recipe_ingredients where item_id = record_id)
      + (select count(*) from public.recipe_review_ingredients where item_id = record_id) where entity in ('PRODUTO','INSUMO')
    union all select 'consumptions', 'Consumos em massadas', (select count(*) from public.batch_ingredient_consumptions where item_id = record_id)
      + (select count(*) from public.batch_packaging_consumptions where item_id = record_id) where entity in ('PRODUTO','INSUMO')
    union all select 'receipts', 'Recebimentos', (select count(*) from public.receipts where supplier_id = record_id) where entity = 'FORNECEDOR'
    union all select 'lots', 'Lotes', (select count(*) from public.inventory_lots where manufacturer_id = record_id) where entity = 'FABRICANTE'
    union all select 'packaging', 'Configurações de embalagem', (select count(*) from public.product_packaging_configs where manufacturer_id = record_id) where entity = 'FABRICANTE'
    union all select 'balances', 'Saldos e movimentações', (select count(*) from public.stock_balances where location_id = record_id) where entity = 'LOCAL'
    union all select 'lots', 'Lotes de abertura', (select count(*) from public.inventory_lots where opening_location_id = record_id) where entity = 'LOCAL'
    union all select 'inventory', 'Sessões e contagens de inventário', (select count(*) from public.inventory_sessions where location_id = record_id)
      + (select count(*) from public.inventory_counts where location_id = record_id) where entity = 'LOCAL'
    union all select 'losses', 'Perdas de massa', (select count(*) from public.production_losses where reason_id = record_id) where entity = 'MOTIVO_PERDA'
    union all select 'waste', 'Descartes de estoque', (select count(*) from public.stock_waste_records where reason_id = record_id) where entity = 'MOTIVO_PERDA'
    union all select 'losses', 'Perdas de massa', (select count(*) from public.production_losses where destination_id = record_id) where entity = 'DESTINACAO_PERDA'
    union all select 'waste', 'Descartes de estoque', (select count(*) from public.stock_waste_records where destination_id = record_id) where entity = 'DESTINACAO_PERDA'
    union all select 'approvals', 'Aprovação técnica', (select count(*) from public.recipe_approvals where recipe_version_id = record_id) where entity = 'VERSAO_RECEITA'
    union all select 'recipe_assignments', 'Associações de receita', (select count(*) from public.customer_product_recipes where recipe_version_id = record_id) where entity = 'VERSAO_RECEITA'
    union all select 'production_orders', 'Ordens de produção', (select count(*) from public.production_orders where recipe_version_id = record_id) where entity = 'VERSAO_RECEITA'
    union all select 'reservations', 'Reservas de estoque', (select count(*) from public.stock_reservations where recipe_version_id = record_id) where entity = 'VERSAO_RECEITA'
    union all select 'losses', 'Perdas de massa', (select count(*) from public.production_losses where recipe_version_id = record_id) where entity = 'VERSAO_RECEITA'
    union all select 'production_orders', 'Ordens de produção', (select count(*) from public.production_orders where packaging_config_id = record_id) where entity = 'CONFIG_EMBALAGEM'
    union all select 'reservations', 'Reservas de estoque', (select count(*) from public.stock_reservations where packaging_config_id = record_id) where entity = 'CONFIG_EMBALAGEM'
    union all select 'outputs', 'Saídas de acabado', (select count(*) from public.batch_finished_outputs where packing_config_id = record_id) where entity = 'CONFIG_EMBALAGEM'
  ) rows where count > 0
$$;

-- Lê o registro com a entidade correta. Retorna versão atual, nome, código e situação.
create function purezza_private.catalog_record(entity text, record_id uuid, lock boolean default false)
returns table(version integer, code text, name text, active boolean, extra text)
language plpgsql security definer set search_path = '' as $$
begin
  if entity = 'CLIENTE' then
    if lock then perform from public.customers where id = record_id for update; end if;
    return query select c.version, c.customer_number::text, c.legal_name, c.active, c.kind from public.customers c where c.id = record_id;
  elsif entity in ('PRODUTO','INSUMO') then
    if lock then perform from public.items where id = record_id for update; end if;
    return query select i.catalog_version, i.original_code, coalesce(i.commercial_description, i.original_description), i.active, i.classification
      from public.items i where i.id = record_id and (i.classification = 'INSUMO') = (entity = 'INSUMO');
  elsif entity = 'FORNECEDOR' then
    if lock then perform from public.suppliers where id = record_id for update; end if;
    return query select s.version, null::text, s.name, s.active, null::text from public.suppliers s where s.id = record_id;
  elsif entity = 'FABRICANTE' then
    if lock then perform from public.manufacturers where id = record_id for update; end if;
    return query select m.version, null::text, m.name, m.active, null::text from public.manufacturers m where m.id = record_id;
  elsif entity = 'LOCAL' then
    if lock then perform from public.locations where id = record_id for update; end if;
    return query select l.version, l.code, l.code, l.active, null::text from public.locations l where l.id = record_id;
  elsif entity = 'MOTIVO_PERDA' then
    if lock then perform from public.loss_reasons where id = record_id for update; end if;
    return query select r.version, null::text, r.name, r.active, null::text from public.loss_reasons r where r.id = record_id;
  elsif entity = 'DESTINACAO_PERDA' then
    if lock then perform from public.loss_destinations where id = record_id for update; end if;
    return query select d.version, null::text, d.name, d.active, null::text from public.loss_destinations d where d.id = record_id;
  elsif entity = 'VERSAO_RECEITA' then
    if lock then perform from public.recipe_versions where id = record_id for update; end if;
    return query select coalesce((select rr.edit_version from public.recipe_reviews rr where rr.recipe_version_id = v.id), 0),
        r.code || ' v' || v.version, r.name, null::boolean, v.status
      from public.recipe_versions v join public.recipes r on r.id = v.recipe_id where v.id = record_id;
  elsif entity = 'CONFIG_EMBALAGEM' then
    if lock then perform from public.product_packaging_configs where id = record_id for update; end if;
    return query select p.version, i.original_code || ' v' || p.version, coalesce(i.commercial_description, i.original_description), null::boolean, null::text
      from public.product_packaging_configs p join public.items i on i.id = p.product_id where p.id = record_id;
  end if;
end
$$;

-- Motivos que impedem inativar (operações em curso). Vazio = pode inativar.
create function purezza_private.catalog_deactivation_blockers(entity text, record_id uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(reason), '{}') from (
    select 'Cliente possui pedido em aberto.' reason where entity = 'CLIENTE' and exists(
      select from public.orders where customer_id = record_id and fulfillment_status in ('RASCUNHO','CONFIRMADO','PARCIAL'))
    union all select 'Item possui saldo físico em estoque.' where entity in ('PRODUTO','INSUMO') and exists(
      select from public.stock_balances b join public.inventory_lots l on l.id = b.lot_id where l.item_id = record_id and b.quantity > 0)
    union all select 'Item possui reserva de estoque ativa.' where entity in ('PRODUTO','INSUMO') and exists(
      select from public.stock_reservations r join public.inventory_lots l on l.id = r.lot_id
      where l.item_id = record_id and r.released_at is null and r.quantity > r.dispatched_quantity)
    union all select 'Item está em pedido em aberto.' where entity in ('PRODUTO','INSUMO') and exists(
      select from public.order_items oi join public.orders o on o.id = oi.order_id
      where oi.item_id = record_id and o.fulfillment_status in ('RASCUNHO','CONFIRMADO','PARCIAL'))
    union all select 'Item possui ordem de produção não concluída.' where entity in ('PRODUTO','INSUMO') and exists(
      select from public.production_orders po join public.production_demands d on d.order_item_id = po.demand_id
      where d.item_id = record_id and po.status <> 'CONCLUIDA')
    union all select 'Local possui saldo físico.' where entity = 'LOCAL' and exists(
      select from public.stock_balances where location_id = record_id and quantity > 0)
    union all select 'Local possui sessão de inventário aberta.' where entity = 'LOCAL' and exists(
      select from public.inventory_sessions where location_id = record_id and closed_at is null)
  ) reasons
$$;

create function purezza_private.catalog_authorize(entity text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not purezza_private.catalog_entity_ok(entity) then
    raise exception using errcode = '22023', message = 'Tipo de cadastro não suportado.';
  end if;
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'Somente Administração pode gerenciar este cadastro.';
  end if;
  if entity in ('DESTINACAO_PERDA','VERSAO_RECEITA') and not exists(
    select from public.profiles where id = auth.uid() and active
      and (case when entity = 'DESTINACAO_PERDA' then can_release_lot else can_approve_recipe end)) then
    raise exception using errcode = '42501', message = case when entity = 'DESTINACAO_PERDA'
      then 'A destinação exige autorização sanitária específica.' else 'A receita exige permissão de aprovação técnica.' end;
  end if;
end
$$;

create function purezza_private.catalog_dependencies(entity text, record_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  rec record;
  deps jsonb;
  blockers text[];
  reasons text[] := '{}';
  only_version boolean := false;
begin
  perform purezza_private.catalog_authorize(entity);
  select * into rec from purezza_private.catalog_record(entity, record_id);
  if not found or rec.version is null then
    raise exception using errcode = 'P0002', message = 'Cadastro não encontrado.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('type', d.type, 'label', d.label, 'count', d.count)), '[]')
    into deps from purezza_private.catalog_dependency_rows(entity, record_id) d;
  if jsonb_array_length(deps) > 0 then
    reasons := array_append(reasons, 'Este cadastro possui histórico de utilização e não pode ser excluído definitivamente.');
  end if;
  if entity = 'VERSAO_RECEITA' then
    if rec.extra = 'APROVADA' then reasons := array_append(reasons, 'Versões aprovadas são preservadas.'); end if;
    select count(*) = 1 into only_version from public.recipe_versions
      where recipe_id = (select recipe_id from public.recipe_versions where id = record_id);
    if only_version then reasons := array_append(reasons, 'É a única versão da receita.'); end if;
  end if;
  blockers := case when entity in ('VERSAO_RECEITA','CONFIG_EMBALAGEM') then array['Este cadastro não possui situação ativa ou inativa.']
    else purezza_private.catalog_deactivation_blockers(entity, record_id) end;
  return jsonb_build_object(
    'entity', entity, 'record_id', record_id, 'record_version', rec.version,
    'code', rec.code, 'name', rec.name, 'active', rec.active,
    'can_delete', cardinality(reasons) = 0,
    'can_deactivate', rec.active is true and cardinality(blockers) = 0,
    'can_reactivate', rec.active is false,
    'reasons', to_jsonb(reasons), 'deactivation_blockers', to_jsonb(blockers),
    'dependencies', deps);
end
$$;

create function purezza_private.delete_catalog_record(entity text, record_id uuid, expected_version integer, reason text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  rec record;
  result_id uuid;
  preview jsonb;
  snapshot jsonb;
begin
  perform purezza_private.catalog_authorize(entity);
  result_id := purezza_private.claim_operation('EXCLUIR_CADASTRO', request_id,
    jsonb_build_array(entity, record_id, expected_version, reason));
  if result_id is not null then return result_id; end if;
  select * into rec from purezza_private.catalog_record(entity, record_id, true);
  if not found or rec.version is null then
    raise exception using errcode = 'P0002', message = 'Cadastro não encontrado. Ele pode já ter sido excluído.';
  end if;
  if rec.version is distinct from expected_version then
    raise exception using errcode = '40001', message = 'Este cadastro foi alterado por outro usuário. Atualize os dados para continuar.';
  end if;
  -- Revalida com a linha travada: uma dependência criada depois da prévia bloqueia aqui.
  preview := purezza_private.catalog_dependencies(entity, record_id);
  if not (preview->>'can_delete')::boolean then
    raise exception using errcode = '23503', message = coalesce(preview->'reasons'->>0, 'O cadastro possui dependências.');
  end if;
  snapshot := jsonb_build_object('codigo', rec.code, 'nome', rec.name);

  if entity = 'CLIENTE' then delete from public.customers where id = record_id;
  elsif entity in ('PRODUTO','INSUMO') then delete from public.items where id = record_id;
  elsif entity = 'FORNECEDOR' then delete from public.suppliers where id = record_id;
  elsif entity = 'FABRICANTE' then delete from public.manufacturers where id = record_id;
  elsif entity = 'LOCAL' then delete from public.locations where id = record_id;
  elsif entity = 'MOTIVO_PERDA' then delete from public.loss_reasons where id = record_id;
  elsif entity = 'DESTINACAO_PERDA' then delete from public.loss_destinations where id = record_id;
  elsif entity = 'VERSAO_RECEITA' then
    delete from public.recipe_review_ingredients where recipe_version_id = record_id;
    delete from public.recipe_reviews where recipe_version_id = record_id;
    delete from public.recipe_ingredients where recipe_version_id = record_id;
    delete from public.recipe_versions where id = record_id;
  elsif entity = 'CONFIG_EMBALAGEM' then delete from public.product_packaging_configs where id = record_id;
  end if;

  insert into public.audit_logs(actor, action, details) values(auth.uid(), 'EXCLUIR_CADASTRO',
    jsonb_build_object('entidade', entity, 'registro_id', record_id, 'versao', rec.version,
      'justificativa', nullif(btrim(reason), ''), 'registro', snapshot, 'request_id', request_id));
  update public.operation_requests set result = record_id
    where actor = auth.uid() and operation = 'EXCLUIR_CADASTRO' and operation_requests.request_id = delete_catalog_record.request_id;
  return record_id;
end
$$;

create function purezza_private.set_catalog_active(entity text, record_id uuid, expected_version integer, next_active boolean, reason text, request_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  rec record;
  blockers text[];
  new_version integer;
  existing uuid;
begin
  perform purezza_private.catalog_authorize(entity);
  if next_active is null or entity in ('VERSAO_RECEITA','CONFIG_EMBALAGEM') then
    raise exception using errcode = '22023', message = 'Este cadastro não possui situação ativa ou inativa.';
  end if;
  if not next_active and nullif(btrim(reason), '') is null then
    raise exception using errcode = '22023', message = 'Informe o motivo da inativação.';
  end if;
  existing := purezza_private.claim_operation('SITUACAO_CADASTRO', request_id,
    jsonb_build_array(entity, record_id, expected_version, next_active, reason));
  if existing is not null then
    select version into new_version from purezza_private.catalog_record(entity, record_id);
    return new_version;
  end if;
  select * into rec from purezza_private.catalog_record(entity, record_id, true);
  if not found or rec.version is null then
    raise exception using errcode = 'P0002', message = 'Cadastro não encontrado.';
  end if;
  if rec.version is distinct from expected_version then
    raise exception using errcode = '40001', message = 'Este cadastro foi alterado por outro usuário. Atualize os dados para continuar.';
  end if;
  if rec.active = next_active then
    raise exception using errcode = '22023', message = case when next_active then 'O cadastro já está ativo.' else 'O cadastro já está inativo.' end;
  end if;
  if not next_active then
    blockers := purezza_private.catalog_deactivation_blockers(entity, record_id);
    if cardinality(blockers) > 0 then
      raise exception using errcode = '23503', message = 'Não é possível inativar: ' || array_to_string(blockers, ' ');
    end if;
  end if;
  -- Reativação confere nome duplicado entre os ativos (a unicidade de código e documento já é garantida no banco).
  if next_active and entity in ('FORNECEDOR','FABRICANTE','MOTIVO_PERDA','DESTINACAO_PERDA') and (
    (entity = 'FORNECEDOR' and exists(select from public.suppliers where id <> record_id and active and lower(btrim(name)) = lower(btrim(rec.name))))
    or (entity = 'FABRICANTE' and exists(select from public.manufacturers where id <> record_id and active and lower(btrim(name)) = lower(btrim(rec.name))))
  ) then
    raise exception using errcode = '23505', message = 'Já existe um cadastro ativo com este nome.';
  end if;

  if entity = 'CLIENTE' then
    update public.customers set active = next_active, version = version + 1, updated_at = now(), updated_by = auth.uid()
      where id = record_id returning version into new_version;
  elsif entity in ('PRODUTO','INSUMO') then
    update public.items set active = next_active, catalog_version = catalog_version + 1 where id = record_id returning catalog_version into new_version;
  elsif entity = 'FORNECEDOR' then
    update public.suppliers set active = next_active, version = version + 1 where id = record_id returning version into new_version;
  elsif entity = 'FABRICANTE' then
    update public.manufacturers set active = next_active, version = version + 1 where id = record_id returning version into new_version;
  elsif entity = 'LOCAL' then
    update public.locations set active = next_active, version = version + 1 where id = record_id returning version into new_version;
  elsif entity = 'MOTIVO_PERDA' then
    update public.loss_reasons set active = next_active, version = version + 1 where id = record_id returning version into new_version;
  elsif entity = 'DESTINACAO_PERDA' then
    update public.loss_destinations set active = next_active, version = version + 1 where id = record_id returning version into new_version;
  end if;

  insert into public.audit_logs(actor, action, details) values(auth.uid(),
    case when next_active then 'REATIVAR_CADASTRO' else 'INATIVAR_CADASTRO' end,
    jsonb_build_object('entidade', entity, 'registro_id', record_id, 'versao', new_version,
      'justificativa', nullif(btrim(reason), ''), 'request_id', request_id));
  update public.operation_requests set result = record_id
    where actor = auth.uid() and operation = 'SITUACAO_CADASTRO' and operation_requests.request_id = set_catalog_active.request_id;
  return new_version;
end
$$;

create function purezza_private.catalog_history(entity text, record_id uuid, page_size integer default 20, page_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  key text := record_id::text;
  result jsonb;
begin
  perform purezza_private.catalog_authorize(entity);
  if page_size not between 1 and 100 or page_offset < 0 then
    raise exception using errcode = '22023', message = 'Paginação inválida.';
  end if;
  with matches as (
    select a.id, a.action, a.details, a.created_at, p.display_name operator from public.audit_logs a
    join public.profiles p on p.id = a.actor
    where a.details @> jsonb_build_object('registro_id', key) or a.details @> jsonb_build_object('cliente_id', key)
      or a.details @> jsonb_build_object('item_id', key) or a.details @> jsonb_build_object('produto_id', key)
      or a.details @> jsonb_build_object('config_id', key) or a.details @> jsonb_build_object('receita_versao_id', key)
  )
  select jsonb_build_object('total', (select count(*) from matches), 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'action', m.action, 'details', m.details - 'request_id',
      'created_at', m.created_at, 'operator', m.operator) order by m.created_at desc)
    from (select * from matches order by created_at desc limit page_size offset page_offset) m), '[]')) into result;
  return result;
end
$$;

-- Produtos (todas as classificações, exceto insumo, que segue em save_operational_catalog).
create function purezza_private.save_item(target uuid, expected_version integer, input jsonb, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  new_code text := nullif(btrim(input->>'code'), '');
  new_description text := nullif(btrim(input->>'description'), '');
  new_commercial text := nullif(btrim(input->>'commercial_description'), '');
  new_class text := nullif(btrim(input->>'classification'), '');
  new_unit text := nullif(btrim(input->>'unit'), '');
  cur public.items%rowtype;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'Somente Administração pode alterar produtos.';
  end if;
  if jsonb_typeof(input) is distinct from 'object' or new_class is null
    or new_class not in ('TERCEIRO','FABRICACAO_PROPRIA','REVENDA_A_VALIDAR','FARINHA_USO_REVENDA_A_VALIDAR') then
    raise exception using errcode = '22023', message = 'Informe uma classificação de produto válida.';
  end if;
  if length(new_commercial) > 180 then
    raise exception using errcode = '22023', message = 'A descrição comercial aceita até 180 caracteres.';
  end if;
  result_id := purezza_private.claim_operation('SALVAR_PRODUTO', request_id, jsonb_build_array(target, expected_version, input));
  if result_id is not null then return result_id; end if;

  if target is null then
    if new_code is null or length(new_code) > 60 or new_description is null or length(new_description) > 180 then
      raise exception using errcode = '22023', message = 'Informe código (até 60) e descrição (até 180 caracteres).';
    end if;
    if new_unit is not null and new_unit not in ('kg','g','L','mL','un') then
      raise exception using errcode = '22023', message = 'Unidade base inválida.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('item/' || lower(new_code), 0));
    if exists(select from public.items where lower(btrim(original_code)) = lower(new_code)) then
      raise exception using errcode = '23505', message = 'Já existe um item com este código.';
    end if;
    insert into public.items(original_code, original_description, commercial_description, classification, base_unit, active)
      values(new_code, new_description, new_commercial, new_class, new_unit, true) returning id into result_id;
  else
    select * into cur from public.items where id = target and classification <> 'INSUMO' for update;
    if not found then raise exception using errcode = 'P0002', message = 'Produto não encontrado.'; end if;
    if cur.catalog_version is distinct from expected_version then
      raise exception using errcode = '40001', message = 'Este cadastro foi alterado por outro usuário. Atualize os dados para continuar.';
    end if;
    if new_class <> cur.classification and exists(select from purezza_private.catalog_dependency_rows('PRODUTO', target)
        where type in ('order_items','lots','demands','recipe_assignments','packaging')) then
      raise exception using errcode = '23503', message = 'A classificação não pode mudar: o produto já tem pedidos, lotes, demandas, receitas ou embalagens.';
    end if;
    update public.items set commercial_description = new_commercial, classification = new_class,
      catalog_version = catalog_version + 1 where id = target returning id into result_id;
  end if;
  insert into public.audit_logs(actor, action, details) values(auth.uid(), 'SALVAR_PRODUTO',
    jsonb_build_object('entidade', 'PRODUTO', 'registro_id', result_id, 'criacao', target is null, 'classificacao', new_class));
  update public.operation_requests set result = result_id
    where actor = auth.uid() and operation = 'SALVAR_PRODUTO' and operation_requests.request_id = save_item.request_id;
  return result_id;
end
$$;

-- Cadastros semelhantes (aviso antes de gravar; a regra definitiva segue nas restrições do banco).
create function purezza_private.catalog_similar(entity text, term text, exclude_id uuid default null)
returns table(id uuid, code text, name text, active boolean)
language plpgsql stable security definer set search_path = '' as $$
declare needle text := public.search_normalize(btrim(coalesce(term, '')));
begin
  if entity = 'CLIENTE' then
    if not purezza_private.has_role('ADMINISTRADOR','VENDAS') then
      raise exception using errcode = '42501', message = 'Seu perfil não acessa clientes.';
    end if;
  else
    perform purezza_private.catalog_authorize(entity);
  end if;
  if length(needle) < 3 then return; end if;
  if entity = 'CLIENTE' then
    return query select c.id, c.customer_number::text, c.legal_name, c.active from public.customers c
      where c.id is distinct from exclude_id and (c.search_text like '%' || needle || '%' or c.document = regexp_replace(term, '\D', '', 'g'))
      order by c.active desc, c.legal_name limit 5;
  elsif entity in ('PRODUTO','INSUMO') then
    return query select i.id, i.original_code, coalesce(i.commercial_description, i.original_description), i.active from public.items i
      where i.id is distinct from exclude_id and (public.search_normalize(i.original_code || ' ' || i.original_description || ' ' || coalesce(i.commercial_description, ''))
        like '%' || needle || '%') order by i.active desc, i.original_code limit 5;
  elsif entity = 'FORNECEDOR' then
    return query select s.id, null::text, s.name, s.active from public.suppliers s
      where s.id is distinct from exclude_id and public.search_normalize(s.name) like '%' || needle || '%' order by s.active desc, s.name limit 5;
  elsif entity = 'FABRICANTE' then
    return query select m.id, null::text, m.name, m.active from public.manufacturers m
      where m.id is distinct from exclude_id and public.search_normalize(m.name) like '%' || needle || '%' order by m.active desc, m.name limit 5;
  elsif entity = 'LOCAL' then
    return query select l.id, l.code, l.code, l.active from public.locations l
      where l.id is distinct from exclude_id and public.search_normalize(l.code) like '%' || needle || '%' order by l.code limit 5;
  end if;
end
$$;

-- Wrappers públicos (security invoker) sobre o schema privado.
create function public.catalog_dependencies(entity text, record_id uuid) returns jsonb
language sql set search_path = '' as $$ select purezza_private.catalog_dependencies(entity, record_id) $$;
create function public.delete_catalog_record(entity text, record_id uuid, expected_version integer, reason text, request_id uuid) returns uuid
language sql set search_path = '' as $$ select purezza_private.delete_catalog_record(entity, record_id, expected_version, reason, request_id) $$;
create function public.set_catalog_active(entity text, record_id uuid, expected_version integer, next_active boolean, reason text, request_id uuid) returns integer
language sql set search_path = '' as $$ select purezza_private.set_catalog_active(entity, record_id, expected_version, next_active, reason, request_id) $$;
create function public.catalog_history(entity text, record_id uuid, page_size integer default 20, page_offset integer default 0) returns jsonb
language sql set search_path = '' as $$ select purezza_private.catalog_history(entity, record_id, page_size, page_offset) $$;
create function public.save_item(target uuid, expected_version integer, input jsonb, request_id uuid) returns uuid
language sql set search_path = '' as $$ select purezza_private.save_item(target, expected_version, input, request_id) $$;
create function public.catalog_similar(entity text, term text, exclude_id uuid default null)
returns table(id uuid, code text, name text, active boolean)
language sql set search_path = '' as $$ select * from purezza_private.catalog_similar(entity, term, exclude_id) $$;

revoke all on function
  purezza_private.catalog_entity_ok(text), purezza_private.catalog_dependency_rows(text, uuid),
  purezza_private.catalog_record(text, uuid, boolean), purezza_private.catalog_deactivation_blockers(text, uuid),
  purezza_private.catalog_authorize(text), purezza_private.catalog_dependencies(text, uuid),
  purezza_private.delete_catalog_record(text, uuid, integer, text, uuid),
  purezza_private.set_catalog_active(text, uuid, integer, boolean, text, uuid),
  purezza_private.catalog_history(text, uuid, integer, integer), purezza_private.save_item(uuid, integer, jsonb, uuid),
  purezza_private.catalog_similar(text, text, uuid),
  public.catalog_dependencies(text, uuid), public.delete_catalog_record(text, uuid, integer, text, uuid),
  public.set_catalog_active(text, uuid, integer, boolean, text, uuid), public.catalog_history(text, uuid, integer, integer),
  public.save_item(uuid, integer, jsonb, uuid), public.catalog_similar(text, text, uuid)
from public, anon;
grant execute on function
  purezza_private.catalog_dependencies(text, uuid), purezza_private.delete_catalog_record(text, uuid, integer, text, uuid),
  purezza_private.set_catalog_active(text, uuid, integer, boolean, text, uuid),
  purezza_private.catalog_history(text, uuid, integer, integer), purezza_private.save_item(uuid, integer, jsonb, uuid),
  purezza_private.catalog_similar(text, text, uuid),
  public.catalog_dependencies(text, uuid), public.delete_catalog_record(text, uuid, integer, text, uuid),
  public.set_catalog_active(text, uuid, integer, boolean, text, uuid), public.catalog_history(text, uuid, integer, integer),
  public.save_item(uuid, integer, jsonb, uuid), public.catalog_similar(text, text, uuid)
to authenticated;
