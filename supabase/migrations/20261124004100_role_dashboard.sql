create function purezza_private.role_dashboard(from_day date,to_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  technical boolean := purezza_private.has_role('ADMINISTRADOR','PRODUCAO');
  commercial boolean := purezza_private.has_role('ADMINISTRADOR','VENDAS');
  today date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
  start_at timestamptz;
  end_at timestamptz;
  operations jsonb;
  sales jsonb;
begin
  if not technical and not commercial then
    raise exception using errcode='42501',message='Seu perfil não pode consultar indicadores.';
  end if;
  if from_day is null or to_day is null or not isfinite(from_day) or not isfinite(to_day)
    or from_day>to_day or to_day>today then
    raise exception using errcode='22023',message='Confira o período de consulta.';
  end if;
  start_at := from_day::timestamp at time zone 'America/Sao_Paulo';
  end_at := (to_day+1)::timestamp at time zone 'America/Sao_Paulo';

  if technical then
    with finished as (
      select entry.batch_id,entry.actual_kg,entry.nominal_kg,
        (entry.finished_at at time zone 'America/Sao_Paulo')::date as day
      from public.batch_finished_outputs entry where entry.finished_at>=start_at and entry.finished_at<end_at
    ), production as (
      select count(*) as finished_count,count(actual_kg) as measured_count,sum(actual_kg) as measured_kg,
        sum(nominal_kg) as nominal_kg from finished
    ), period_losses as (
      select entry.batch_id,entry.quantity_kg,entry.reason_id,
        (entry.occurred_at at time zone 'America/Sao_Paulo')::date as day
      from public.production_losses entry where entry.occurred_at>=start_at and entry.occurred_at<end_at
    ), linked_loss as (
      select sum(quantity_kg) as kg from period_losses where batch_id in (select batch_id from finished)
    ), cause_totals as (
      select reason.name,sum(loss.quantity_kg) as quantity
      from period_losses loss join public.loss_reasons reason on reason.id=loss.reason_id group by reason.name
    ), daily_sources as (
      select day,count(*) as finished_count,count(actual_kg) as measured_count,sum(actual_kg) as measured_kg,null::numeric as loss_kg
      from finished group by day
      union all
      select day,0,0,null,sum(quantity_kg) from period_losses group by day
    ), daily as (
      select day,sum(finished_count) as finished_count,sum(measured_count) as measured_count,
        sum(measured_kg)::text as measured_kg,sum(loss_kg)::text as loss_kg
      from daily_sources group by day
    ), expiring as (
      select count(*) filter(where lot.expires_on<=today) as expired,
        count(*) filter(where lot.expires_on>today and lot.expires_on<=today+7 and lot.status='LIBERADO') as next_seven
      from public.inventory_lots lot where lot.expiry='INFORMADA' and lot.expires_on<=today+7
        and exists(select from public.stock_balances balance where balance.lot_id=lot.id and balance.quantity>0)
    )
    select jsonb_build_object(
      'finished_count',production.finished_count,'measured_count',production.measured_count,
      'measured_kg',production.measured_kg::text,'nominal_kg',production.nominal_kg::text,
      'avg_measured_kg',round(production.measured_kg/nullif(production.measured_count,0),3)::text,
      'mass_loss_kg',(select sum(quantity_kg)::text from period_losses),
      'linked_loss_kg',linked_loss.kg::text,
      'linked_loss_pct',case when production.finished_count=production.measured_count and production.measured_kg>0
        and linked_loss.kg is not null
        then round(100*linked_loss.kg/(production.measured_kg+linked_loss.kg),2)::text end,
      'expired_lots',expiring.expired,'expiring_released_lots',expiring.next_seven,
      'daily',coalesce((select jsonb_agg(to_jsonb(daily) order by day) from daily),'[]'::jsonb),
      'loss_causes',coalesce((select jsonb_agg(jsonb_build_object('reason',name,'kg',quantity::text)
        order by quantity desc,name) from cause_totals),'[]'::jsonb)
    ) into operations from production,linked_loss,expiring;
  end if;

  if commercial then
    with due_orders as (
      select purchase.id,purchase.fulfillment_status,purchase.delivery_date
      from public.orders purchase where purchase.delivery_date between from_day and to_day
        and purchase.fulfillment_status in ('CONFIRMADO','PARCIAL','EXPEDIDO')
    ), deadlines as (
      select due.*,(due.delivery_date+1)::timestamp at time zone 'America/Sao_Paulo' as cutoff
      from due_orders due where due.delivery_date<today
    ), otif as (
      select count(*) as eligible_count,count(*) filter(where not exists(
        select from public.order_items entry where entry.order_id=deadline.id
          and entry.quantity>coalesce((
            select sum(shipment.quantity)
            from public.stock_reservations reservation join public.shipments shipment on shipment.reservation_id=reservation.id
            where reservation.order_item_id=entry.id and shipment.delivered_at<deadline.cutoff
          ),0)
      )) as on_time_complete_count from deadlines deadline
    ), billing as (
      select count(*) as records_count,sum(amount) as amount from public.billing_records where issued_on between from_day and to_day
    )
    select jsonb_build_object(
      'open_orders',(select count(*) from due_orders where fulfillment_status in ('CONFIRMADO','PARCIAL')),
      'overdue_orders',(select count(*) from due_orders where fulfillment_status in ('CONFIRMADO','PARCIAL') and delivery_date<today),
      'otif_eligible',otif.eligible_count,'otif_on_time_complete',otif.on_time_complete_count,
      'otif_pct',round(100.0*otif.on_time_complete_count/nullif(otif.eligible_count,0),2)::text,
      'billing_count',billing.records_count,'billed_amount',billing.amount::text
    ) into sales from otif,billing;
  end if;

  return jsonb_build_object('from_day',from_day,'to_day',to_day,'today',today,
    'operations',operations,'commercial',sales);
end
$$;

create function public.role_dashboard(from_day date,to_day date)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.role_dashboard(from_day,to_day)
$$;
revoke all on function purezza_private.role_dashboard(date,date),public.role_dashboard(date,date) from public,anon,authenticated;
grant execute on function purezza_private.role_dashboard(date,date),public.role_dashboard(date,date) to authenticated;
