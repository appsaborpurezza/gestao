create function purezza_private.stock_position_report(as_of date, filter_item uuid, filter_location uuid, page_size int, page_offset int)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  cutoff timestamptz;
  report jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR', 'PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode consultar a posição de estoque.';
  end if;
  if as_of is null or not isfinite(as_of) or as_of > (statement_timestamp() at time zone 'America/Sao_Paulo')::date
    or (page_size is not null and page_size not between 1 and 100) or page_offset is null or page_offset < 0 then
    raise exception using errcode = '22023', message = 'Informe data válida e paginação dentro dos limites.';
  end if;
  cutoff := (as_of + 1)::timestamp at time zone 'America/Sao_Paulo';

  with position as (
    select movement.lot_id, movement.location_id, sum(movement.quantity_delta) as quantity
    from public.stock_movements movement
    join public.inventory_lots lot on lot.id = movement.lot_id
    where movement.created_at < cutoff
      and (filter_item is null or lot.item_id = filter_item)
      and (filter_location is null or movement.location_id = filter_location)
    group by movement.lot_id, movement.location_id
    having sum(movement.quantity_delta) <> 0
  ), paged as (
    select item.original_code as item_code,
      coalesce(item.commercial_description, item.original_description) as item_description,
      lot.internal_code as lot_code, location.code as location_code,
      lot.unit, position.quantity::text as quantity
    from position
    join public.inventory_lots lot on lot.id = position.lot_id
    join public.items item on item.id = lot.item_id
    join public.locations location on location.id = position.location_id
    order by item.original_code, lot.internal_code, location.code
    limit page_size offset page_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from position),
    'rows', coalesce(
      (select jsonb_agg(to_jsonb(paged) order by item_code, lot_code, location_code) from paged),
      '[]'::jsonb
    )
  ) into report;
  return report;
end
$$;

revoke all on function purezza_private.stock_position_report(date,uuid,uuid,int,int) from public, anon, authenticated;
grant execute on function purezza_private.stock_position_report(date,uuid,uuid,int,int) to authenticated;

create or replace function public.stock_position(as_of date, filter_item uuid, filter_location uuid, page_size int, page_offset int)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if page_size is null then
    raise exception using errcode = '22023', message = 'Informe o tamanho da página.';
  end if;
  return purezza_private.stock_position_report(as_of, filter_item, filter_location, page_size, page_offset);
end
$$;

create function public.export_stock_position(as_of date, filter_item uuid, filter_location uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select purezza_private.stock_position_report(as_of, filter_item, filter_location, null, 0)
    || jsonb_build_object('generated_at', statement_timestamp())
$$;

revoke all on function public.export_stock_position(date,uuid,uuid) from public, anon, authenticated;
grant execute on function public.export_stock_position(date,uuid,uuid) to authenticated;
