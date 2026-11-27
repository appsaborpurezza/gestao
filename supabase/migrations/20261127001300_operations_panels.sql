-- Painéis departamentais (Produção, Estoque, Qualidade, Comercial) com filtros reais.
-- Somente leitura e incremental: role_dashboard continua existindo e sem mudança.
-- Produção, Estoque e Qualidade: ADMINISTRADOR e PRODUCAO. Comercial (com valores): ADMINISTRADOR e VENDAS.

create function purezza_private.operations_panels(from_day date, to_day date, filters jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  technical boolean := purezza_private.has_role('ADMINISTRADOR','PRODUCAO');
  commercial boolean := purezza_private.has_role('ADMINISTRADOR','VENDAS');
  today date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
  start_at timestamptz;
  end_at timestamptz;
  recipe_filter text;
  customer_filter text;
  class_filter text;
  production jsonb;
  stock jsonb;
  quality jsonb;
  sales jsonb;
begin
  if not technical and not commercial then
    raise exception using errcode='42501',message='Seu perfil não pode consultar os painéis.';
  end if;
  if from_day is null or to_day is null or not isfinite(from_day) or not isfinite(to_day)
    or from_day>to_day or to_day>today or to_day-from_day>366 then
    raise exception using errcode='22023',message='Confira o período de consulta (até 367 dias).';
  end if;
  filters := coalesce(filters,'{}'::jsonb);
  if jsonb_typeof(filters)<>'object'
    or exists(select from jsonb_object_keys(filters) k where k not in ('recipe','customer','classification'))
    or exists(select from jsonb_each(filters) f where jsonb_typeof(f.value) not in ('string','null')) then
    raise exception using errcode='22023',message='Confira os filtros do painel.';
  end if;
  recipe_filter := nullif(btrim(filters->>'recipe'),'');
  customer_filter := nullif(btrim(filters->>'customer'),'');
  class_filter := nullif(btrim(filters->>'classification'),'');
  if length(recipe_filter)>200 or length(customer_filter)>200 or (class_filter is not null and class_filter not in
    ('TERCEIRO','FABRICACAO_PROPRIA','REVENDA_A_VALIDAR','FARINHA_USO_REVENDA_A_VALIDAR','INSUMO')) then
    raise exception using errcode='22023',message='Confira os filtros do painel.';
  end if;
  start_at := from_day::timestamp at time zone 'America/Sao_Paulo';
  end_at := (to_day+1)::timestamp at time zone 'America/Sao_Paulo';

  if technical then
    -- Produção: planejado x realizado, rendimento, tempos e produtividade por etapa.
    with plans as (
      select plan.id,plan.production_number,plan.recipe_name,d.customer_name,d.delivery_date,
        plan.yield_kg,plan.batches_count,plan.yield_kg*plan.batches_count as planned_kg
      from public.production_orders plan join public.production_demands d on d.order_item_id=plan.demand_id
      where (recipe_filter is null or plan.recipe_name=recipe_filter)
        and (customer_filter is null or d.customer_name=customer_filter)
    ), batch_out as (
      select b.id,b.production_order_id,b.started_at,o.finished_at,o.actual_kg,o.nominal_kg,
        (o.finished_at at time zone 'America/Sao_Paulo')::date as finished_day
      from public.production_batches b left join public.batch_finished_outputs o on o.batch_id=b.id
      where b.production_order_id in (select id from plans)
    ), due as (
      select p.*,
        (select count(*) from batch_out bo where bo.production_order_id=p.id and bo.finished_at is not null) as done,
        (select coalesce(sum(coalesce(bo.actual_kg,bo.nominal_kg)),0) from batch_out bo
          where bo.production_order_id=p.id and bo.finished_at is not null) as produced_kg,
        (select max(bo.finished_at) from batch_out bo where bo.production_order_id=p.id) as last_finished
      from plans p where p.delivery_date between from_day and to_day
    ), finished as (
      select bo.*,p.recipe_name,p.yield_kg from batch_out bo join plans p on p.id=bo.production_order_id
      where bo.finished_at>=start_at and bo.finished_at<end_at
    ), daily_sources as (
      select delivery_date as day,planned_kg,0::numeric as produced_kg from due
      union all
      select finished_day,0,coalesce(actual_kg,nominal_kg) from finished
    ), daily as (
      select day,sum(planned_kg)::text as planned_kg,sum(produced_kg)::text as produced_kg
      from daily_sources group by day
    ), recipe_yield as (
      select f.recipe_name,count(*) as batches,sum(f.yield_kg) as planned_kg,count(f.actual_kg) as measured,
        sum(f.actual_kg) as actual_kg,sum(f.yield_kg) filter(where f.actual_kg is not null) as planned_measured_kg,
        avg(extract(epoch from f.finished_at-f.started_at)) filter(where f.started_at is not null) as lead_seconds,
        (select coalesce(sum(loss.quantity_kg),0) from public.production_losses loss
          where loss.batch_id in (select x.id from finished x where x.recipe_name=f.recipe_name)) as loss_kg
      from finished f group by f.recipe_name
    ), stage_runs as (
      select s.stage,s.finished_by,p.yield_kg,
        greatest(0,extract(epoch from s.finished_at-s.started_at)-coalesce((
          select sum(extract(epoch from coalesce(pause.resumed_at,s.finished_at)-pause.paused_at))
          from public.production_stage_pauses pause where pause.batch_id=s.batch_id and pause.stage=s.stage),0)) as net_seconds,
        coalesce((select sum(extract(epoch from coalesce(pause.resumed_at,s.finished_at)-pause.paused_at))
          from public.production_stage_pauses pause where pause.batch_id=s.batch_id and pause.stage=s.stage),0) as pause_seconds
      from public.production_batch_stages s
      join public.production_batches b on b.id=s.batch_id
      join plans p on p.id=b.production_order_id
      where s.status='CONCLUIDA' and s.finished_at>=start_at and s.finished_at<end_at
    ), stages as (
      select stage,count(*) as completed,count(distinct finished_by) as operators,
        round((avg(net_seconds)/60)::numeric,1) as avg_minutes,
        round((percentile_cont(0.5) within group (order by net_seconds)/60)::numeric,1) as median_minutes,
        round((avg(pause_seconds)/60)::numeric,1) as avg_pause_minutes,
        round(sum(yield_kg)/nullif(sum(net_seconds)/3600,0),1) as kg_per_hour
      from stage_runs group by stage
    )
    select jsonb_build_object(
      'plan',jsonb_build_object(
        'orders',(select count(*) from due),
        'planned_kg',(select coalesce(sum(planned_kg),0)::text from due),
        'produced_kg',(select coalesce(sum(produced_kg),0)::text from due),
        'attainment_pct',(select round(100*sum(produced_kg)/nullif(sum(planned_kg),0),1)::text from due),
        'batches_planned',(select coalesce(sum(batches_count),0) from due),
        'batches_done',(select coalesce(sum(done),0) from due),
        'complete',(select count(*) from due where done>=batches_count),
        'on_time',(select count(*) from due where done>=batches_count
          and last_finished<(delivery_date+1)::timestamp at time zone 'America/Sao_Paulo'),
        'late',(select count(*) from due where done<batches_count and delivery_date<today)),
      'finished_batches',(select count(*) from finished),
      'finished_kg',(select coalesce(sum(coalesce(actual_kg,nominal_kg)),0)::text from finished),
      'yield_pct',(select round(100*sum(actual_kg)/nullif(sum(yield_kg) filter(where actual_kg is not null),0),1)::text from finished),
      'lead_hours',(select round((avg(extract(epoch from finished_at-started_at))/3600)::numeric,1)::text
        from finished where started_at is not null),
      'daily',coalesce((select jsonb_agg(to_jsonb(daily) order by day) from daily),'[]'::jsonb),
      'orders_due',coalesce((select jsonb_agg(jsonb_build_object('production_number',production_number,
          'recipe_name',recipe_name,'customer_name',customer_name,'delivery_date',delivery_date,
          'batches_count',batches_count,'done',done,'planned_kg',planned_kg::text,'produced_kg',produced_kg::text,
          'late',done<batches_count and delivery_date<today) order by delivery_date,production_number)
        from (select * from due order by delivery_date,production_number limit 200) d),'[]'::jsonb),
      'by_recipe',coalesce((select jsonb_agg(jsonb_build_object('recipe_name',recipe_name,'batches',batches,
          'planned_kg',planned_kg::text,'actual_kg',actual_kg::text,'measured',measured,
          'yield_pct',round(100*actual_kg/nullif(planned_measured_kg,0),1)::text,
          'loss_kg',loss_kg::text,'lead_hours',round((lead_seconds/3600)::numeric,1)::text)
        order by planned_kg desc,recipe_name) from recipe_yield),'[]'::jsonb),
      'by_stage',coalesce((select jsonb_agg(jsonb_build_object('stage',stage,'completed',completed,'operators',operators,
          'avg_minutes',avg_minutes::text,'median_minutes',median_minutes::text,'avg_pause_minutes',avg_pause_minutes::text,
          'kg_per_hour',kg_per_hour::text)
        order by array_position(array['PREPARACAO','BATER_MASSA','CILINDROS','EMBALAGEM'],stage)) from stages),'[]'::jsonb)
    ) into production;

    -- Estoque: saldo atual (independe do período), por situação, classificação e validade.
    with bal as (
      select lot.id,lot.status::text as status,lot.expiry,lot.expires_on,lot.production_batch_id,item.classification,
        sum(balance.quantity) as quantity,
        sum(case lot.unit when 'kg' then balance.quantity when 'g' then balance.quantity/1000 end) as kg
      from public.inventory_lots lot
      join public.stock_balances balance on balance.lot_id=lot.id
      join public.items item on item.id=lot.item_id
      where balance.quantity>0 and (class_filter is null or item.classification=class_filter)
      group by lot.id,item.classification
    )
    select jsonb_build_object(
      'lots',(select count(*) from bal),
      'kg',(select coalesce(sum(kg),0)::text from bal),
      'finished_goods_kg',(select coalesce(sum(kg),0)::text from bal where production_batch_id is not null and status='LIBERADO'),
      'quarantine',(select count(*) from bal where status='QUARENTENA'),
      'blocked',(select count(*) from bal where status in ('BLOQUEADO','REPROVADO')),
      'expired',(select count(*) from bal where expiry='INFORMADA' and expires_on<=today),
      'expiring_7',(select count(*) from bal where expiry='INFORMADA' and expires_on>today and expires_on<=today+7),
      'expiring_30',(select count(*) from bal where expiry='INFORMADA' and expires_on>today and expires_on<=today+30),
      'by_status',coalesce((select jsonb_agg(jsonb_build_object('status',status,'lots',lots,'kg',kg::text) order by status)
        from (select status,count(*) as lots,coalesce(sum(kg),0) as kg from bal group by status) s),'[]'::jsonb),
      'by_classification',coalesce((select jsonb_agg(jsonb_build_object('classification',classification,'lots',lots,'kg',kg::text)
          order by kg desc,classification)
        from (select classification,count(*) as lots,coalesce(sum(kg),0) as kg from bal group by classification) c),'[]'::jsonb)
    ) into stock;

    -- Qualidade: perdas do período, recolhimentos, lotes bloqueados e massadas abaixo do peso nominal.
    with scoped_batches as (
      select b.id from public.production_batches b join public.production_orders plan on plan.id=b.production_order_id
      join public.production_demands d on d.order_item_id=plan.demand_id
      where (recipe_filter is null or plan.recipe_name=recipe_filter) and (customer_filter is null or d.customer_name=customer_filter)
    ), losses as (
      select loss.quantity_kg,loss.operation,reason.name as reason,destination.name as destination
      from public.production_losses loss
      join public.loss_reasons reason on reason.id=loss.reason_id
      join public.loss_destinations destination on destination.id=loss.destination_id
      where loss.occurred_at>=start_at and loss.occurred_at<end_at
        and ((recipe_filter is null and customer_filter is null) or loss.batch_id in (select id from scoped_batches))
    ), outputs as (
      select o.actual_kg,o.nominal_kg from public.batch_finished_outputs o
      where o.finished_at>=start_at and o.finished_at<end_at and o.batch_id in (select id from scoped_batches)
    )
    select jsonb_build_object(
      'loss_kg',(select coalesce(sum(quantity_kg),0)::text from losses),
      'loss_pct',(select round(100*(select sum(quantity_kg) from losses)
        /nullif((select sum(quantity_kg) from losses)+(select sum(coalesce(actual_kg,nominal_kg)) from outputs),0),2)::text),
      'underweight',(select count(*) from outputs where actual_kg<nominal_kg),
      'measured',(select count(actual_kg) from outputs),
      'recalls_opened',(select count(*) from public.recall_cases r where r.opened_at>=start_at and r.opened_at<end_at),
      'recalls_open',(select count(*) from public.recall_cases r where r.closed_at is null),
      'pending_release',(select count(*) from public.inventory_lots lot where lot.production_batch_id is not null and lot.status='QUARENTENA'
        and exists(select from public.stock_balances balance where balance.lot_id=lot.id and balance.quantity>0)),
      'by_reason',coalesce((select jsonb_agg(jsonb_build_object('name',reason,'kg',kg::text) order by kg desc,reason)
        from (select reason,sum(quantity_kg) kg from losses group by reason) x),'[]'::jsonb),
      'by_destination',coalesce((select jsonb_agg(jsonb_build_object('name',destination,'kg',kg::text) order by kg desc,destination)
        from (select destination,sum(quantity_kg) kg from losses group by destination) x),'[]'::jsonb),
      'by_operation',coalesce((select jsonb_agg(jsonb_build_object('name',operation,'kg',kg::text)
          order by array_position(array['PREPARACAO','BATER_MASSA','CILINDROS','EMBALAGEM','OUTRA'],operation))
        from (select operation,sum(quantity_kg) kg from losses group by operation) x),'[]'::jsonb)
    ) into quality;
  end if;

  if commercial then
    -- Comercial: pedidos com entrega no período, expedições e faturamento por cliente.
    with period_orders as (
      select purchase.id,purchase.customer_name,purchase.fulfillment_status,purchase.delivery_date
      from public.orders purchase
      where purchase.delivery_date between from_day and to_day and purchase.fulfillment_status<>'RASCUNHO'
        and (customer_filter is null or purchase.customer_name=customer_filter)
    ), ordered as (
      select o.customer_name,o.id,
        sum(case when entry.unit='kg' then entry.quantity when entry.unit='g' then entry.quantity/1000
          else entry.quantity*entry.kg_per_unit end) as kg
      from period_orders o join public.order_items entry on entry.order_id=o.id group by o.customer_name,o.id
    ), billed as (
      select purchase.customer_name,sum(record.amount) as amount,count(*) as records
      from public.billing_records record join public.orders purchase on purchase.id=record.order_id
      where record.issued_on between from_day and to_day and (customer_filter is null or purchase.customer_name=customer_filter)
      group by purchase.customer_name
    ), customers as (
      select coalesce(o.customer_name,b.customer_name) as customer_name,coalesce(o.orders,0) as orders,o.kg,b.amount
      from (select customer_name,count(*) as orders,sum(kg) as kg from ordered group by customer_name) o
      full join billed b on b.customer_name=o.customer_name
    )
    select jsonb_build_object(
      'orders',(select count(*) from period_orders),
      'ordered_kg',(select sum(kg)::text from ordered),
      'shipped',(select count(*) from period_orders where fulfillment_status='EXPEDIDO'),
      'partial',(select count(*) from period_orders where fulfillment_status='PARCIAL'),
      'open',(select count(*) from period_orders where fulfillment_status='CONFIRMADO'),
      'overdue',(select count(*) from period_orders where fulfillment_status in ('CONFIRMADO','PARCIAL') and delivery_date<today),
      'shipments',(select count(*) from public.shipments s join public.orders purchase on purchase.id=s.order_id
        where s.dispatched_at>=start_at and s.dispatched_at<end_at
          and (customer_filter is null or purchase.customer_name=customer_filter)),
      'billed_amount',(select sum(amount)::text from billed),
      'customers',coalesce((select jsonb_agg(jsonb_build_object('customer_name',customer_name,'orders',orders,
          'kg',kg::text,'amount',amount::text) order by amount desc nulls last,kg desc nulls last,customer_name)
        from (select * from customers order by amount desc nulls last,kg desc nulls last limit 50) c),'[]'::jsonb)
    ) into sales;
  end if;

  return jsonb_build_object('from_day',from_day,'to_day',to_day,'today',today,
    'filters',jsonb_build_object('recipe',recipe_filter,'customer',customer_filter,'classification',class_filter),
    'production',production,'stock',stock,'quality',quality,'commercial',sales);
end
$$;

create function public.operations_panels(from_day date, to_day date, filters jsonb)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.operations_panels(from_day,to_day,filters)
$$;
revoke all on function purezza_private.operations_panels(date,date,jsonb),public.operations_panels(date,date,jsonb) from public,anon,authenticated;
grant execute on function purezza_private.operations_panels(date,date,jsonb),public.operations_panels(date,date,jsonb) to authenticated;
