create function purezza_private.production_board_columns(page_size int, page_offsets jsonb, search text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  stages constant text[] := array['PLANEJADA','EM_PREPARACAO','EM_BATER_MASSA','EM_CILINDROS','EM_EMBALAGEM','FINALIZADA'];
  accents constant text := 'áàãâäéèêëíìîïóòõôöúùûüç';
  plain constant text := 'aaaaaeeeeiiiiooooouuuuc';
  needle text;
  show_operator boolean;
  result jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO','VENDAS') then
    raise exception using errcode='42501',message='Seu perfil não pode consultar o quadro de produção.';
  end if;
  if page_size is null or page_size not between 1 and 50 or jsonb_typeof(page_offsets) is distinct from 'object'
    or char_length(coalesce(search,''))>100 then
    raise exception using errcode='22023',message='Confira a pesquisa e a paginação.';
  end if;
  if exists(select from jsonb_each(page_offsets) e where not(e.key=any(stages)) or e.value::text !~ '^(0|[1-9][0-9]{0,8})$') then
    raise exception using errcode='22023',message='Confira a paginação.';
  end if;
  needle := translate(lower(btrim(coalesce(search,''))),accents,plain);
  show_operator := purezza_private.has_role('ADMINISTRADOR','PRODUCAO');

  with candidates as materialized (
    select b.id,b.sequence,b.status,b.version,b.lot_code,b.started_at,
      plan.production_number,plan.batches_count,d.order_number,d.customer_name,d.description,d.delivery_date,
      output_lot.internal_code as output_code
    from public.production_batches b
    join public.production_orders plan on plan.id=b.production_order_id
    join public.production_demands d on d.order_item_id=plan.demand_id
    left join public.batch_finished_outputs output on output.batch_id=b.id
    left join public.inventory_lots output_lot on output_lot.id=output.output_lot_id
    where b.status=any(stages)
      and (needle='' or strpos(translate(lower(concat_ws(' ',plan.production_number,d.order_number,
        d.customer_name,d.description,b.lot_code,output_lot.internal_code)),accents,plain),needle)>0)
  ), counts as (
    select status,count(*) as total from candidates group by status
  ), columns as (
    select selected.status,coalesce(counts.total,0) as total,coalesce(details.rows,'[]'::jsonb) as rows
    from unnest(stages) selected(status)
    left join counts on counts.status=selected.status
    left join lateral (
      select jsonb_agg(to_jsonb(card) order by card.delivery_date,card.production_number,card.sequence,card.id) rows
      from (
        select page.*,stage.started_at as stage_started_at,stage.status as stage_status,
          greatest(0,floor(extract(epoch from statement_timestamp()-stage.started_at)-coalesce(pauses.seconds,0))) as stage_net_seconds,
          case when show_operator then actor.display_name end as operator,
          exists(select from public.recall_affected_batches affected where affected.batch_id=page.id and affected.resume_authorized_at is null) as recalled
        from (
          select * from candidates where candidates.status=selected.status
          order by delivery_date,production_number,sequence,id
          limit page_size offset coalesce((page_offsets->>selected.status)::int,0)
        ) page
        left join public.production_batch_stages stage on stage.batch_id=page.id and stage.status in ('EM_EXECUCAO','PAUSADA')
        left join lateral (
          select sum(greatest(0,extract(epoch from coalesce(entry.resumed_at,statement_timestamp())-entry.paused_at))) seconds
          from public.production_stage_pauses entry where entry.batch_id=stage.batch_id and entry.stage=stage.stage
        ) pauses on stage.batch_id is not null
        left join public.profiles actor on actor.id=stage.started_by and show_operator
      ) card
    ) details on true
  )
  select jsonb_object_agg(status,jsonb_build_object('total',total,'rows',rows)) into result from columns;
  return result;
end
$$;

create function public.production_board_columns(page_size int,page_offsets jsonb,search text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.production_board_columns(page_size,page_offsets,search)
$$;
revoke all on function purezza_private.production_board_columns(int,jsonb,text),public.production_board_columns(int,jsonb,text)
  from public,anon,authenticated;
grant execute on function purezza_private.production_board_columns(int,jsonb,text),public.production_board_columns(int,jsonb,text)
  to authenticated;
