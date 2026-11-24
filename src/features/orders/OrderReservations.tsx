import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'

type Position = { inventory_lots: { internal_code: string; status: string; expires_on: string | null } | null
  locations: { code: string; active: boolean } | null }

export function OrderReservations({ lineId, unit, deliveryDate }: { lineId: string; unit: string; deliveryDate: string | null }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const inFlight = useRef(false)
  const pending = useRef(new Map<string, string>())
  const cache = useQueryClient()
  const reserves = useQuery({
    queryKey: ['orders', 'reservations', lineId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase.from('stock_reservations')
        .select('id,quantity::text,dispatched_quantity::text,stock_balances(inventory_lots(internal_code,status,expires_on),locations(code,active))')
        .eq('order_item_id', lineId).is('released_at', null).order('reserved_at')
      if (error) throw error
      return data.filter(row => row.quantity !== row.dispatched_quantity)
        .map(row => ({ ...row, position: row.stock_balances as unknown as Position | null }))
    },
  })
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const cutoff = deliveryDate && deliveryDate > today ? deliveryDate : today

  async function submit(event: FormEvent<HTMLFormElement>, targetReservation?: string) {
    event.preventDefault()
    if (inFlight.current) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const params = targetReservation
      ? { target_reservation: targetReservation, reason: fields.get('reason') }
      : { target_line: lineId, amount: String(fields.get('amount')).replace(',', '.') }
    const operation = targetReservation ? 'release_stock_reservation' : 'reserve_order_stock'
    const fingerprint = JSON.stringify([operation, params])
    const request_id = pending.current.get(fingerprint) ?? crypto.randomUUID()
    pending.current.set(fingerprint, request_id)
    inFlight.current = true
    setBusy(true)
    setMessage('')
    try {
      const { error } = await supabase.rpc(operation, { ...params, request_id })
      if (error) throw new Error(error.message)
      pending.current.delete(fingerprint)
      setError(false)
      setMessage(targetReservation ? 'Reserva liberada.' : 'Reserva registrada.')
      form.reset()
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['orders', 'reservations', lineId] }),
        cache.invalidateQueries({ queryKey: ['orders', 'actual-demand-coverage', lineId] }),
        cache.invalidateQueries({ queryKey: ['inventory'] }),
        cache.invalidateQueries({ queryKey: ['shipping'] }),
      ])
    } catch (cause) {
      setError(true)
      setMessage(cause instanceof Error ? cause.message : 'Falha ao atualizar as reservas.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Gerenciar reservas</summary>
    {open && <>
      <form onSubmit={event => void submit(event)}>
        <label>Quantidade para reservar ({unit}) <input name="amount" inputMode="decimal"
          pattern={unit === 'un' ? '[0-9]+' : '[0-9]+([,.][0-9]{1,6})?'} required/></label>
        <button disabled={busy}>Reservar por FEFO</button>
      </form>
      {message && <p role={error ? 'alert' : 'status'}>{message}</p>}
      {reserves.isPending && <p role="status">Carregando reservas…</p>}
      {reserves.isError && <p role="alert">Falha ao consultar as reservas ativas.</p>}
      {reserves.data?.length === 0 && <p>Nenhuma reserva ativa.</p>}
      {reserves.data?.map(reservation => {
        const position = reservation.position
        const lot = position?.inventory_lots
        const expired = Boolean(lot?.expires_on && lot.expires_on <= cutoff)
        return <article key={reservation.id}>
          <p>{lot?.internal_code} · {position?.locations?.code} · Reserva original {formatStockQuantity(reservation.quantity)} {unit}
            {' · '}Despachado {formatStockQuantity(reservation.dispatched_quantity)} {unit}</p>
          {(lot?.status !== 'LIBERADO' || !position?.locations?.active || expired) &&
            <p role="status">Lote ou local deixou de atender aos critérios da reserva.</p>}
          <form onSubmit={event => void submit(event, reservation.id)}>
            <label>Motivo da liberação <input name="reason" maxLength={500} required/></label>
            <button className="secondary" disabled={busy}>Liberar reserva</button>
          </form>
        </article>
      })}
    </>}
  </details>
}
