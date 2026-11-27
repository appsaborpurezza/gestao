-- Etapa 4: pendências de CRUD e UX. Incremental, sem alterar migrations aplicadas e sem apagar histórico.
-- 1. Editar motivos e destinações de perda (versão, idempotência, auditoria com antes e depois).
-- 2. Descontinuar e reativar receitas: a receita sai do uso para novas associações e novas OPs; histórico intacto.
-- 3. Excluir conversões de unidade substituídas e sem uso (nunca referenciadas por pedidos). A vigente nunca é excluída.
-- 4. Busca global com OPs, massadas e expedições (mesma assinatura de workspace_search, como em 00900).
-- 5. Linha do tempo de atividades (auditoria) para Administração.

-- 1. Motivos e destinações -----------------------------------------------------------------------
create function purezza_private.update_loss_option(kind text, target uuid, expected_version int, input jsonb, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  old_row jsonb;
  new_name text := btrim(coalesce(input->>'name',''));
  new_reference text := nullif(btrim(coalesce(input->>'authorization_reference','')),'');
begin
  if kind not in ('MOTIVO_PERDA','DESTINACAO_PERDA') then
    raise exception using errcode='22023',message='Tipo de cadastro não suportado.';
  end if;
  perform purezza_private.catalog_authorize(kind);
  if length(new_name) not between 1 and (case kind when 'MOTIVO_PERDA' then 100 else 120 end)
    or (kind='DESTINACAO_PERDA' and (new_reference is null or length(new_reference)>500)) then
    raise exception using errcode='22023',message='Confira o nome e a referência informados.';
  end if;
  previous := purezza_private.claim_operation('EDITAR_'||kind,request_id,jsonb_build_array(target,expected_version,input));
  if previous is not null then return previous; end if;
  if kind='MOTIVO_PERDA' then
    select jsonb_build_object('nome',name,'versao',version) into old_row from public.loss_reasons where id=target for update;
  else
    select jsonb_build_object('nome',name,'referencia',authorization_reference,'versao',version) into old_row
      from public.loss_destinations where id=target for update;
  end if;
  if old_row is null then raise exception using errcode='P0002',message='Cadastro não encontrado.'; end if;
  if (old_row->>'versao')::int<>expected_version then
    raise exception using errcode='40001',message='Este cadastro foi alterado por outra pessoa. Recarregue e tente novamente.';
  end if;
  begin
    if kind='MOTIVO_PERDA' then
      update public.loss_reasons set name=new_name,version=version+1 where id=target;
    else
      update public.loss_destinations set name=new_name,authorization_reference=new_reference,version=version+1 where id=target;
    end if;
  exception when unique_violation then
    raise exception using errcode='23505',message='Já existe um cadastro com este nome.';
  end;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'EDITAR_CADASTRO',jsonb_build_object(
    'entidade',kind,'registro_id',target,'antes',old_row - 'versao',
    'depois',jsonb_strip_nulls(jsonb_build_object('nome',new_name,'referencia',new_reference)),'request_id',request_id));
  update public.operation_requests set result=target
    where actor=auth.uid() and operation='EDITAR_'||kind and operation_requests.request_id=update_loss_option.request_id;
  return target;
end
$$;

-- 2. Descontinuação de receitas ------------------------------------------------------------------
alter table public.recipes
  add column discontinued_at timestamptz,
  add column discontinued_by uuid references public.profiles,
  add column discontinued_reason text,
  add constraint recipes_discontinued_check check (
    (discontinued_at is null and discontinued_by is null and discontinued_reason is null)
    or (discontinued_at is not null and discontinued_by is not null
      and length(btrim(discontinued_reason)) between 1 and 500));

create function purezza_private.recipe_usage(target_recipe uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode='42501',message='Seu perfil não pode consultar receitas.';
  end if;
  return jsonb_build_object(
    'active_assignments',(select count(*) from public.customer_product_recipes a
      join public.recipe_versions v on v.id=a.recipe_version_id where v.recipe_id=target_recipe and a.ends_at is null),
    'open_orders',(select count(*) from public.production_orders o
      join public.recipe_versions v on v.id=o.recipe_version_id where v.recipe_id=target_recipe and o.status<>'CONCLUIDA'),
    'pending_versions',(select count(*) from public.recipe_versions v where v.recipe_id=target_recipe and v.status='PENDENTE_VALIDACAO'));
end
$$;

create function purezza_private.set_recipe_discontinued(target_recipe uuid, discontinued boolean, reason text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  r record;
  usage jsonb;
  op text := case when discontinued then 'DESCONTINUAR_RECEITA' else 'REATIVAR_RECEITA' end;
begin
  perform purezza_private.catalog_authorize('VERSAO_RECEITA');
  if length(btrim(coalesce(reason,''))) not between 1 and 500 then
    raise exception using errcode='22023',message='Informe a justificativa (até 500 caracteres).';
  end if;
  previous := purezza_private.claim_operation(op,request_id,jsonb_build_array(target_recipe,reason));
  if previous is not null then return previous; end if;
  select id,code,name,discontinued_at into r from public.recipes where id=target_recipe for update;
  if not found then raise exception using errcode='P0002',message='Receita não encontrada.'; end if;
  if discontinued then
    if r.discontinued_at is not null then
      raise exception using errcode='40001',message='Esta receita já está descontinuada.';
    end if;
    -- As associações vigentes são encerradas pela tela de associações, com motivo próprio: nada é encerrado aqui.
    perform from public.customer_product_recipes a join public.recipe_versions v on v.id=a.recipe_version_id
      where v.recipe_id=target_recipe and a.ends_at is null for share of a;
    usage := purezza_private.recipe_usage(target_recipe);
    if (usage->>'active_assignments')::int>0 then
      raise exception using errcode='23503',message=format(
        'Encerre antes as %s associações vigentes desta receita em Associações de receitas.',usage->>'active_assignments');
    end if;
    update public.recipes set discontinued_at=statement_timestamp(),discontinued_by=auth.uid(),discontinued_reason=btrim(reason)
      where id=target_recipe;
  else
    if r.discontinued_at is null then
      raise exception using errcode='40001',message='Esta receita já está em uso.';
    end if;
    update public.recipes set discontinued_at=null,discontinued_by=null,discontinued_reason=null where id=target_recipe;
  end if;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),op,jsonb_build_object(
    'entidade','RECEITA','registro_id',target_recipe,'justificativa',btrim(reason),
    'registro',jsonb_build_object('codigo',r.code,'nome',r.name),'request_id',request_id));
  update public.operation_requests set result=target_recipe
    where actor=auth.uid() and operation=op and operation_requests.request_id=set_recipe_discontinued.request_id;
  return target_recipe;
end
$$;

-- Bloqueio no banco: nenhuma nova associação ou OP com receita descontinuada, venha de onde vier.
create function purezza_private.block_discontinued_recipe()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists(select from public.recipe_versions v join public.recipes r on r.id=v.recipe_id
    where v.id=new.recipe_version_id and r.discontinued_at is not null) then
    raise exception using errcode='23514',message='Esta receita está descontinuada. Reative-a antes de usá-la.';
  end if;
  return new;
end
$$;
create trigger customer_product_recipes_discontinued before insert on public.customer_product_recipes
  for each row execute function purezza_private.block_discontinued_recipe();
create trigger production_orders_discontinued before insert on public.production_orders
  for each row execute function purezza_private.block_discontinued_recipe();

-- 3. Conversões de unidade -----------------------------------------------------------------------
create function purezza_private.delete_unit_conversion(target uuid, reason text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  c public.item_unit_conversions%rowtype;
  latest int;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode='42501',message='Somente Administração pode excluir conversões.';
  end if;
  if length(btrim(coalesce(reason,''))) not between 1 and 500 then
    raise exception using errcode='22023',message='Informe a justificativa (até 500 caracteres).';
  end if;
  previous := purezza_private.claim_operation('EXCLUIR_CONVERSAO',request_id,jsonb_build_array(target,reason));
  if previous is not null then return previous; end if;
  select * into c from public.item_unit_conversions where id=target;
  if not found then raise exception using errcode='P0002',message='Conversão não encontrada. Ela pode já ter sido excluída.'; end if;
  perform from public.items where id=c.item_id for update;
  perform from public.item_unit_conversions where id=target for update;
  if exists(select from public.order_items where conversion_id=target) then
    raise exception using errcode='23503',message='Esta conversão já foi usada em pedidos e não pode ser excluída. Cadastre uma nova versão.';
  end if;
  select unit_version into latest from public.items where id=c.item_id;
  if c.version=latest then
    raise exception using errcode='23503',message='Esta é a conversão vigente e não pode ser excluída. Para corrigir, cadastre uma nova versão.';
  end if;
  delete from public.item_unit_conversions where id=target;
  insert into public.audit_logs(actor,action,details) values(auth.uid(),'EXCLUIR_CADASTRO',jsonb_build_object(
    'entidade','CONVERSAO_UNIDADE','registro_id',target,'item_id',c.item_id,'justificativa',btrim(reason),
    'registro',jsonb_build_object('unidade',c.source_unit,'kg_por_unidade',c.kg_per_unit,'versao',c.version,
      'versao_vigente',latest),'request_id',request_id));
  update public.operation_requests set result=target
    where actor=auth.uid() and operation='EXCLUIR_CONVERSAO' and operation_requests.request_id=delete_unit_conversion.request_id;
  return target;
end
$$;

create function purezza_private.unit_conversion_usage(target uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('orders',(select count(*) from public.order_items where conversion_id=target))
  where purezza_private.has_role('ADMINISTRADOR','PRODUCAO')
$$;

-- 4. Busca global ---------------------------------------------------------------------------------
-- Expedições: Produção opera a expedição e já vê pedido e cliente em shipment_history, mas não lê `orders`.
-- Esta função devolve só id, cliente e número do pedido, para os três perfis, como shipment_history.
create function purezza_private.search_shipments(needle text)
returns table(record_id uuid, label text, reference text)
language sql stable security definer set search_path = '' as $$
  select s.id,o.customer_name,'Pedido '||o.order_number
  from public.shipments s join public.orders o on o.id=s.order_id
  where purezza_private.has_role('ADMINISTRADOR','PRODUCAO','VENDAS')
    and strpos(translate(lower(concat_ws(' ','expedicao','pedido',o.order_number,o.customer_name)),
      'áàãâäéèêëíìîïóòõôöúùûüç','aaaaaeeeeiiiiooooouuuuc'),needle)>0
  order by s.dispatched_at desc limit 50
$$;

create or replace function public.workspace_search(search_text text, page_offset integer default 0)
returns table(module text, record_id uuid, label text, reference text)
language plpgsql stable security invoker set search_path = '' as $$
declare
  accents constant text := 'áàãâäéèêëíìîïóòõôöúùûüç';
  plain constant text := 'aaaaaeeeeiiiiooooouuuuc';
  needle text := translate(lower(btrim(coalesce(search_text,''))),accents,plain);
  commercial boolean := purezza_private.has_role('ADMINISTRADOR','VENDAS');
  technical boolean := purezza_private.has_role('ADMINISTRADOR','PRODUCAO');
  administrative boolean := purezza_private.has_role('ADMINISTRADOR');
begin
  if not (commercial or technical) then
    raise exception using errcode='42501',message='Seu perfil não pode pesquisar registros.';
  end if;
  if page_offset is null or page_offset<0 or char_length(needle) not between 2 and 100 then
    raise exception using errcode='22023',message='Confira o termo e a página da busca.';
  end if;
  return query
  with matches as (
    select 'products'::text section,i.id,
      coalesce(i.commercial_description,i.original_description) title,i.original_code ref
    from public.items i
    where strpos(translate(lower(concat_ws(' ',i.original_code,i.original_description,i.commercial_description)),accents,plain),needle)>0
    union all
    select 'customers',c.id,c.legal_name,c.customer_number::text from public.customers c
    where commercial and strpos(translate(lower(concat_ws(' ',c.customer_number,c.legal_name,c.trade_name)),accents,plain),needle)>0
    union all
    select 'orders',o.id,o.customer_name,o.order_number::text from public.orders o
    where commercial and strpos(translate(lower(concat_ws(' ',o.order_number,o.customer_name)),accents,plain),needle)>0
    union all
    select 'recipes',r.id,r.name,r.code from public.recipes r
    where technical and strpos(translate(lower(concat_ws(' ',r.code,r.name)),accents,plain),needle)>0
    union all
    select 'traceability',l.id,coalesce(i.commercial_description,i.original_description),l.internal_code
    from public.inventory_lots l
    join public.items i on i.id=l.item_id
    left join public.manufacturers m on m.id=l.manufacturer_id
    where technical and strpos(translate(lower(concat_ws(' ',l.internal_code,l.original_lot,
      i.original_code,i.original_description,i.commercial_description,m.name)),accents,plain),needle)>0
    union all
    select 'operational-catalog',s.id,s.name,'Fornecedor' from public.suppliers s
    where administrative and strpos(translate(lower(s.name),accents,plain),needle)>0
    union all
    select 'operational-catalog',f.id,f.name,'Fabricante' from public.manufacturers f
    where administrative and strpos(translate(lower(f.name),accents,plain),needle)>0
    union all
    -- OPs: o Kanban abre filtrado pelo número (referência "OP n").
    select 'production-board',plan.id,plan.recipe_name||' · '||d.customer_name,'OP '||plan.production_number
    from public.production_orders plan join public.production_demands d on d.order_item_id=plan.demand_id
    where technical and strpos(translate(lower(concat_ws(' ','op',plan.production_number,plan.recipe_name,d.customer_name,
      'pedido',d.order_number)),accents,plain),needle)>0
    union all
    -- Massadas: pelo código do lote de produção (SP-AAAAMMDD-NNNN).
    select 'production-board',b.id,plan.recipe_name||' · massada '||b.sequence||'/'||plan.batches_count,b.lot_code
    from public.production_batches b join public.production_orders plan on plan.id=b.production_order_id
    where technical and b.lot_code is not null and strpos(lower(b.lot_code),needle)>0
    union all
    -- Expedições: por pedido ou cliente.
    select 'shipping',found.record_id,found.label,found.reference from purezza_private.search_shipments(needle) found
  )
  select section,id,title,ref from matches order by section,lower(title),ref,id limit 17 offset page_offset;
end
$$;

-- 5. Linha do tempo -------------------------------------------------------------------------------
create function purezza_private.activity_timeline(filters jsonb, before_at timestamptz, page_size int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  actor_filter uuid;
  action_filter text;
  entity_filter uuid;
  from_day date;
  to_day date;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode='42501',message='Somente Administração pode consultar a linha do tempo.';
  end if;
  filters := coalesce(filters,'{}'::jsonb);
  begin
    if jsonb_typeof(filters)<>'object'
      or exists(select from jsonb_object_keys(filters) k where k not in ('actor','action','record','from','to')) then
      raise exception using errcode='22023';
    end if;
    actor_filter := nullif(filters->>'actor','')::uuid;
    entity_filter := nullif(filters->>'record','')::uuid;
    action_filter := nullif(btrim(filters->>'action'),'');
    from_day := nullif(filters->>'from','')::date;
    to_day := nullif(filters->>'to','')::date;
  exception when others then
    raise exception using errcode='22023',message='Confira os filtros da linha do tempo.';
  end;
  if page_size is null or page_size not between 1 and 100 or length(action_filter)>60 then
    raise exception using errcode='22023',message='Confira os filtros da linha do tempo.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'created_at',a.created_at,'action',a.action,
      'actor',p.display_name,'actor_id',a.actor,'details',a.details) order by a.created_at desc,a.id)
    from (select * from public.audit_logs entry
      where (before_at is null or entry.created_at<before_at)
        and (actor_filter is null or entry.actor=actor_filter)
        and (action_filter is null or entry.action=action_filter)
        and (entity_filter is null or entry.details @> jsonb_build_object('registro_id',entity_filter))
        and (from_day is null or entry.created_at>=from_day::timestamp at time zone 'America/Sao_Paulo')
        and (to_day is null or entry.created_at<(to_day+1)::timestamp at time zone 'America/Sao_Paulo')
      order by entry.created_at desc,entry.id limit page_size) a
    left join public.profiles p on p.id=a.actor),'[]'::jsonb);
end
$$;

create function purezza_private.activity_actions()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(action order by action),'[]'::jsonb) from (select distinct action from public.audit_logs) a
  where purezza_private.has_role('ADMINISTRADOR')
$$;

-- Wrappers públicos -------------------------------------------------------------------------------
create function public.update_loss_option(kind text, target uuid, expected_version int, input jsonb, request_id uuid) returns uuid
language sql set search_path = '' as $$ select purezza_private.update_loss_option(kind,target,expected_version,input,request_id) $$;
create function public.recipe_usage(target_recipe uuid) returns jsonb
language sql stable set search_path = '' as $$ select purezza_private.recipe_usage(target_recipe) $$;
create function public.set_recipe_discontinued(target_recipe uuid, discontinued boolean, reason text, request_id uuid) returns uuid
language sql set search_path = '' as $$ select purezza_private.set_recipe_discontinued(target_recipe,discontinued,reason,request_id) $$;
create function public.delete_unit_conversion(target uuid, reason text, request_id uuid) returns uuid
language sql set search_path = '' as $$ select purezza_private.delete_unit_conversion(target,reason,request_id) $$;
create function public.unit_conversion_usage(target uuid) returns jsonb
language sql stable set search_path = '' as $$ select purezza_private.unit_conversion_usage(target) $$;
create function public.activity_timeline(filters jsonb, before_at timestamptz, page_size int) returns jsonb
language sql stable set search_path = '' as $$ select purezza_private.activity_timeline(filters,before_at,page_size) $$;
create function public.activity_actions() returns jsonb
language sql stable set search_path = '' as $$ select purezza_private.activity_actions() $$;

revoke all on function
  purezza_private.update_loss_option(text,uuid,int,jsonb,uuid), public.update_loss_option(text,uuid,int,jsonb,uuid),
  purezza_private.recipe_usage(uuid), public.recipe_usage(uuid),
  purezza_private.set_recipe_discontinued(uuid,boolean,text,uuid), public.set_recipe_discontinued(uuid,boolean,text,uuid),
  purezza_private.block_discontinued_recipe(),
  purezza_private.delete_unit_conversion(uuid,text,uuid), public.delete_unit_conversion(uuid,text,uuid),
  purezza_private.unit_conversion_usage(uuid), public.unit_conversion_usage(uuid),
  purezza_private.activity_timeline(jsonb,timestamptz,int), public.activity_timeline(jsonb,timestamptz,int),
  purezza_private.activity_actions(), public.activity_actions(), purezza_private.search_shipments(text)
from public, anon, authenticated;
grant execute on function
  purezza_private.update_loss_option(text,uuid,int,jsonb,uuid), public.update_loss_option(text,uuid,int,jsonb,uuid),
  purezza_private.recipe_usage(uuid), public.recipe_usage(uuid),
  purezza_private.set_recipe_discontinued(uuid,boolean,text,uuid), public.set_recipe_discontinued(uuid,boolean,text,uuid),
  purezza_private.delete_unit_conversion(uuid,text,uuid), public.delete_unit_conversion(uuid,text,uuid),
  purezza_private.unit_conversion_usage(uuid), public.unit_conversion_usage(uuid),
  purezza_private.activity_timeline(jsonb,timestamptz,int), public.activity_timeline(jsonb,timestamptz,int),
  purezza_private.activity_actions(), public.activity_actions(), purezza_private.search_shipments(text)
to authenticated;
