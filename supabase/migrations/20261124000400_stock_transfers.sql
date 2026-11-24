create function purezza_private.transfer_stock(
  target_lot uuid, from_location uuid, to_location uuid, amount numeric, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous uuid;
  lot_unit text;
  transfer_id uuid := gen_random_uuid();
  active_locations integer;
begin
  if not purezza_private.has_role('ADMINISTRADOR','PRODUCAO') then
    raise exception using errcode = '42501', message = 'Seu perfil não pode transferir estoque.';
  end if;

  previous := purezza_private.claim_operation('TRANSFERENCIA', request_id,
    jsonb_build_array(target_lot, from_location, to_location, amount));
  if previous is not null then return previous; end if;

  if from_location is null or to_location is null or from_location = to_location
    or amount is null or not (amount > 0 and amount < 1000000000000)
    or amount <> round(amount, 6) then
    raise exception using errcode = '22023', message = 'Informe locais distintos e uma quantidade válida.';
  end if;

  -- Serialize movements of the same lot, including transfers in opposite directions.
  select unit into lot_unit from public.inventory_lots where id = target_lot for update;
  if not found or (lot_unit = 'un' and amount <> trunc(amount)) then
    raise exception using errcode = '22023', message = 'Confira o lote e a quantidade na unidade base.';
  end if;

  perform id from public.locations
    where id in (from_location, to_location) and active order by id for share;
  get diagnostics active_locations = row_count;
  if active_locations <> 2 then
    raise exception using errcode = '22023', message = 'Origem ou destino inativo ou inexistente.';
  end if;

  update public.stock_balances set quantity = quantity - amount
    where lot_id = target_lot and location_id = from_location and quantity >= amount;
  if not found then
    raise exception using errcode = '22023', message = 'Saldo físico insuficiente na origem.';
  end if;

  insert into public.stock_balances(lot_id, location_id, quantity)
    values(target_lot, to_location, amount)
    on conflict (lot_id, location_id) do update
      set quantity = public.stock_balances.quantity + excluded.quantity;

  insert into public.stock_movements(lot_id, location_id, quantity_delta, kind, actor, correlation_id)
    values(target_lot, from_location, -amount, 'TRANSFERENCIA', auth.uid(), transfer_id),
          (target_lot, to_location, amount, 'TRANSFERENCIA', auth.uid(), transfer_id);

  update public.operation_requests set result = transfer_id
    where actor = auth.uid() and operation = 'TRANSFERENCIA'
      and operation_requests.request_id = transfer_stock.request_id;
  return transfer_id;
end
$$;

create function public.transfer_stock(
  target_lot uuid, from_location uuid, to_location uuid, amount numeric, request_id uuid
)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.transfer_stock(target_lot, from_location, to_location, amount, request_id)
$$;

revoke all on function purezza_private.transfer_stock(uuid,uuid,uuid,numeric,uuid),
  public.transfer_stock(uuid,uuid,uuid,numeric,uuid) from public, anon, authenticated;
grant execute on function purezza_private.transfer_stock(uuid,uuid,uuid,numeric,uuid),
  public.transfer_stock(uuid,uuid,uuid,numeric,uuid) to authenticated;
