-- Kanban de produção, segunda versão da consulta: filtros combináveis, ordenação, totais em kg,
-- indicadores agregados no servidor (os mesmos para quadro, terminal e TV) e agrupamento por OP.
-- Incremental: production_board_columns continua existindo e sem mudança. Somente leitura.

create function purezza_private.production_board_query(page_size int, page_offsets jsonb, filters jsonb, sort text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  stages constant text[] := array['PLANEJADA','EM_PREPARACAO','EM_BATER_MASSA','EM_CILINDROS','EM_EMBALAGEM','FINALIZADA'];
  states constant text[] := array['running','paused','waiting','blocked','done'];
  accents constant text := 'áàãâäéèêëíìîïóòõôöúùûüç';
  plain constant text := 'aaaaaeeeeiiiiooooouuuuc';
  today date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
  needle text;
  wanted_states text[];
  deadline text;
  date_from date;
  date_to date;
  op bigint;
  show_operator boolean;
  result jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO','VENDAS') then
    raise exception using errcode='42501',message='Seu perfil não pode consultar o quadro de produção.';
  end if;
  filters := coalesce(filters, '{}'::jsonb);
  if page_size is null or page_size not between 1 and 50 or jsonb_typeof(page_offsets) is distinct from 'object'
    or jsonb_typeof(filters) is distinct from 'object' or char_length(coalesce(filters->>'search',''))>100
    or coalesce(sort,'delivery') not in ('delivery','op','stage_time','recent') then
    raise exception using errcode='22023',message='Confira os filtros, a ordenação e a paginação.';
  end if;
  if exists(select from jsonb_each(page_offsets) e where not(e.key=any(stages)) or e.value::text !~ '^(0|[1-9][0-9]{0,8})$') then
    raise exception using errcode='22023',message='Confira a paginação.';
  end if;
  begin
    wanted_states := case when jsonb_typeof(filters->'states') = 'array'
      then array(select jsonb_array_elements_text(filters->'states')) end;
    deadline := nullif(filters->>'deadline','');
    date_from := nullif(filters->>'delivery_from','')::date;
    date_to := nullif(filters->>'delivery_to','')::date;
    op := nullif(filters->>'production_number','')::bigint;
  exception when others then
    raise exception using errcode='22023',message='Confira os filtros.';
  end;
  if (wanted_states is not null and not (wanted_states <@ states)) or deadline not in ('late','soon','today','week') then
    raise exception using errcode='22023',message='Confira os filtros.';
  end if;
  needle := translate(lower(btrim(coalesce(filters->>'search',''))),accents,plain);
  show_operator := purezza_private.has_role('ADMINISTRADOR','PRODUCAO');

  with base as materialized (
    select b.id,b.sequence,b.status,b.version,b.lot_code,b.started_at,b.production_order_id,
      plan.production_number,plan.batches_count,plan.yield_kg,d.order_number,d.customer_name,d.description,d.delivery_date,
      output_lot.internal_code as output_code,output.actual_kg,output.finished_at,
      stage.started_at as stage_started_at,stage.status as stage_status,stage.started_by,stage.stage as stage_name,
      exists(select from public.recall_affected_batches affected where affected.batch_id=b.id and affected.resume_authorized_at is null) as recalled
    from public.production_batches b
    join public.production_orders plan on plan.id=b.production_order_id
    join public.production_demands d on d.order_item_id=plan.demand_id
    left join public.batch_finished_outputs output on output.batch_id=b.id
    left join public.inventory_lots output_lot on output_lot.id=output.output_lot_id
    left join public.production_batch_stages stage on stage.batch_id=b.id and stage.status in ('EM_EXECUCAO','PAUSADA')
    where b.status=any(stages)
      and (needle='' or strpos(translate(lower(concat_ws(' ',plan.production_number,d.order_number,
        d.customer_name,d.description,b.lot_code,output_lot.internal_code)),accents,plain),needle)>0)
      and (op is null or plan.production_number=op)
      and (date_from is null or d.delivery_date>=date_from)
      and (date_to is null or d.delivery_date<=date_to)
  ), classified as materialized (
    select base.*,
      case when recalled then 'blocked' when stage_status='PAUSADA' then 'paused' when status='FINALIZADA' then 'done'
        when stage_status='EM_EXECUCAO' then 'running' else 'waiting' end as state,
      case when status='FINALIZADA' then null when delivery_date<today then 'late'
        when delivery_date<=today+2 then 'soon' else 'ok' end as deadline_state,
      greatest(0,floor(extract(epoch from statement_timestamp()-stage_started_at)-coalesce((
        select sum(greatest(0,extract(epoch from coalesce(entry.resumed_at,statement_timestamp())-entry.paused_at)))
        from public.production_stage_pauses entry where entry.batch_id=base.id and entry.stage=base.stage_name),0))) as stage_net_seconds
    from base
  ), candidates as materialized (
    select * from classified
    where (wanted_states is null or state=any(wanted_states))
      and (deadline is null
        or (deadline='late' and deadline_state='late')
        or (deadline='soon' and deadline_state in ('late','soon'))
        or (deadline='today' and delivery_date=today and status<>'FINALIZADA')
        or (deadline='week' and delivery_date between today and today+6 and status<>'FINALIZADA'))
  ), counts as (
    select status,count(*) as total,coalesce(sum(case when status='FINALIZADA' then coalesce(actual_kg,yield_kg) else yield_kg end),0) as kg
    from candidates group by status
  ), columns as (
    select selected.status,coalesce(counts.total,0) as total,coalesce(counts.kg,0) as kg,coalesce(details.rows,'[]'::jsonb) as rows
    from unnest(stages) selected(status)
    left join counts on counts.status=selected.status
    left join lateral (
      select jsonb_agg(jsonb_build_object(
          'id',card.id,'sequence',card.sequence,'status',card.status,'version',card.version,'lot_code',card.lot_code,
          'started_at',card.started_at,'production_number',card.production_number,'batches_count',card.batches_count,
          'order_number',card.order_number,'customer_name',card.customer_name,'description',card.description,
          'delivery_date',card.delivery_date,'output_code',card.output_code,'stage_started_at',card.stage_started_at,
          'stage_status',card.stage_status,'stage_net_seconds',card.stage_net_seconds,'recalled',card.recalled,
          'planned_kg',card.yield_kg,'actual_kg',card.actual_kg,
          'operator',case when show_operator then actor.display_name end) order by card.ord) rows
      from (
        select candidates.*,row_number() over (order by
          case when coalesce(sort,'delivery')='delivery' then candidates.delivery_date end,
          case when sort='op' then candidates.production_number end,
          case when sort='stage_time' then candidates.stage_net_seconds end desc nulls last,
          case when sort='recent' then coalesce(candidates.finished_at,candidates.stage_started_at,candidates.started_at) end desc nulls last,
          candidates.delivery_date,candidates.production_number,candidates.sequence,candidates.id) as ord
        from candidates where candidates.status=selected.status
        order by ord
        limit page_size offset coalesce((page_offsets->>selected.status)::int,0)
      ) card
      left join public.profiles actor on actor.id=card.started_by and show_operator
    ) details on true
  ), summary as (
    select count(*) filter (where status<>'FINALIZADA') as active,
      coalesce(sum(yield_kg) filter (where status<>'FINALIZADA'),0) as active_kg,
      count(*) filter (where state='running') as running,
      count(*) filter (where state='paused') as paused,
      count(*) filter (where state='waiting') as waiting,
      count(*) filter (where state='blocked') as blocked,
      count(*) filter (where deadline_state='late') as late,
      count(*) filter (where deadline_state='soon') as soon,
      count(*) filter (where status='FINALIZADA' and (finished_at at time zone 'America/Sao_Paulo')::date=today) as finished_today,
      coalesce(sum(actual_kg) filter (where status='FINALIZADA' and (finished_at at time zone 'America/Sao_Paulo')::date=today),0) as finished_today_kg,
      count(*) filter (where status='FINALIZADA') as finished_total
    from candidates
  ), per_stage as (
    select production_number,status,count(*) as n from candidates group by production_number,status
  ), groups as (
    -- Uma linha por OP com massadas ativas no filtro: progresso por etapa e prazo. Limite de 100 OPs.
    select jsonb_agg(g order by g.delivery_date, g.production_number) as rows from (
      select c.production_number,min(c.description) as description,min(c.customer_name) as customer_name,min(c.order_number) as order_number,
        min(c.delivery_date) as delivery_date,max(c.batches_count) as batches_count,
        count(*) filter (where c.status='FINALIZADA') as done,
        sum(c.yield_kg) as planned_kg,coalesce(sum(c.actual_kg),0) as produced_kg,
        count(*) filter (where c.state='blocked') as blocked,count(*) filter (where c.state='paused') as paused,
        bool_or(c.deadline_state='late') as late,
        (select jsonb_object_agg(p.status,p.n) from per_stage p where p.production_number=c.production_number) as by_stage
      from candidates c
      group by c.production_number
      having count(*) filter (where c.status<>'FINALIZADA')>0
      order by min(c.delivery_date),c.production_number
      limit 100
    ) g
  )
  select jsonb_build_object(
    'columns',(select jsonb_object_agg(status,jsonb_build_object('total',total,'kg',kg,'rows',rows)) from columns),
    'summary',(select to_jsonb(summary) from summary),
    'groups',coalesce((select rows from groups),'[]'::jsonb),
    'today',today) into result;
  return result;
end
$$;

create function public.production_board_query(page_size int, page_offsets jsonb, filters jsonb, sort text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.production_board_query(page_size,page_offsets,filters,sort)
$$;
revoke all on function purezza_private.production_board_query(int,jsonb,jsonb,text),public.production_board_query(int,jsonb,jsonb,text)
  from public,anon,authenticated;
grant execute on function purezza_private.production_board_query(int,jsonb,jsonb,text),public.production_board_query(int,jsonb,jsonb,text)
  to authenticated;
