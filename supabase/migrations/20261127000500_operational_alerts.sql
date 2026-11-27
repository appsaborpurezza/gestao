create function public.operational_alerts()
returns table(code text, severity text, quantity bigint)
language plpgsql stable security invoker set search_path = '' as $$
declare
  today date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
  technical boolean := purezza_private.has_role('ADMINISTRADOR','PRODUCAO');
  commercial boolean := purezza_private.has_role('ADMINISTRADOR','VENDAS');
begin
  if not (technical or commercial) then
    raise exception using errcode='42501',message='Seu perfil não pode consultar alertas.';
  end if;
  if commercial then
    return query
      select 'ORDERS_OVERDUE','critical',count(*) from public.orders
      where fulfillment_status in ('CONFIRMADO','PARCIAL') and delivery_date<today having count(*)>0
      union all
      select 'ORDERS_DUE_SOON','attention',count(*) from public.orders
      where fulfillment_status in ('CONFIRMADO','PARCIAL') and delivery_date between today and today+3 having count(*)>0;
  end if;
  if technical then
    return query
      with lots as materialized (
        select l.status,l.expiry,l.expires_on from public.inventory_lots l
        where exists(select from public.stock_balances b where b.lot_id=l.id and b.quantity>0)
      )
      select 'LOTS_EXPIRED','critical',count(*) from lots where expiry='INFORMADA' and expires_on<=today having count(*)>0
      union all
      select 'LOTS_EXPIRING','attention',count(*) from lots
      where status='LIBERADO' and expiry='INFORMADA' and expires_on between today+1 and today+7 having count(*)>0
      union all
      select 'LOTS_QUARANTINE','attention',count(*) from lots where status='QUARENTENA' having count(*)>0
      union all
      select 'RECALLS_ACTIVE','critical',count(*) from public.recall_cases where closed_at is null having count(*)>0
      union all
      select 'INVENTORIES_OPEN','attention',count(*) from public.inventory_sessions where closed_at is null having count(*)>0
      union all
      select 'RECIPES_PENDING','attention',count(*) from public.recipe_versions where status='PENDENTE_VALIDACAO' having count(*)>0;
  end if;
end
$$;
revoke all on function public.operational_alerts() from public,anon,authenticated;
grant execute on function public.operational_alerts() to authenticated;
