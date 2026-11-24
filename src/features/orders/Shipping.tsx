import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { ShipmentHistory } from './ShipmentHistory'

type QueueRow = {
  id: string; order_number: number; customer_name: string; delivery_date: string; description: string
  unit: string; internal_code: string; location_code: string; remaining: string; eligible: boolean
}
const pageSize = 20

export function Shipping({ allowOperations }: { allowOperations: boolean }) {
  const [view, setView] = useState<'queue' | 'history'>(allowOperations ? 'queue' : 'history')
  const cache = useQueryClient()
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null)
  const pending = useRef(new Map<string, string>())
  const inFlight = useRef(false)
  const queue = useQuery({
    queryKey: ['shipping', 'queue', page],
    enabled: allowOperations && view === 'queue',
    queryFn: async () => {
      const { data, error } = await supabase.rpc('shipping_queue', {
        page_size: pageSize, page_offset: page * pageSize,
      })
      if (error) throw error
      return data as { total: number; rows: QueueRow[] }
    },
  })

  async function dispatch(event: FormEvent<HTMLFormElement>, reservation: QueueRow) {
    event.preventDefault()
    if (inFlight.current) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const params = {
      target_reservation: reservation.id,
      amount: String(fields.get('amount')).replace(',', '.'),
      method: fields.get('method'),
      notes: fields.get('notes'),
    }
    const fingerprint = JSON.stringify(params)
    const request_id = pending.current.get(fingerprint) ?? crypto.randomUUID()
    pending.current.set(fingerprint, request_id)
    inFlight.current = true
    setBusy(true)
    setFeedback(null)
    try {
      const { error } = await supabase.rpc('confirm_shipment', { ...params, request_id })
      if (error) throw new Error(error.message)
      pending.current.delete(fingerprint)
      form.reset()
      setFeedback({ text: 'Despacho registrado e saldo físico atualizado.', error: false })
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['shipping'] }),
        cache.invalidateQueries({ queryKey: ['orders'] }),
        cache.invalidateQueries({ queryKey: ['inventory'] }),
      ])
    } catch (cause) {
      setFeedback({ text: cause instanceof Error ? cause.message : 'Falha ao confirmar o despacho.', error: true })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <section className="panel">
    <h1>Expedição</h1>
    {allowOperations && <nav aria-label="Expedição">
      <button type="button" aria-pressed={view === 'queue'} onClick={() => setView('queue')}>Fila de despacho</button>
      <button type="button" aria-pressed={view === 'history'} onClick={() => setView('history')}>Histórico</button>
    </nav>}
    {view === 'history' || !allowOperations ? <ShipmentHistory allowConfirmation={allowOperations}/> : <>
    {feedback && <p role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {queue.isPending && <p role="status">Carregando reservas para expedição…</p>}
    {queue.isError && <p role="alert">Falha ao consultar a fila de expedição.</p>}
    {queue.data?.rows.length === 0 && <p>Nenhuma reserva nesta página.</p>}
    {queue.data?.rows.map(row => <article key={row.id}>
      <h2>Pedido {row.order_number} · {row.customer_name}</h2>
      <p>{row.description} · Entrega prevista em {row.delivery_date.split('-').reverse().join('/')}</p>
      <p>Lote {row.internal_code} · Local {row.location_code} · Reservado {formatStockQuantity(row.remaining)} {row.unit}</p>
      {row.eligible ? <details><summary>Conferir e despachar</summary>
        <form onSubmit={event => void dispatch(event, row)}>
          <label>Quantidade despachada ({row.unit}) <input name="amount" inputMode="decimal"
            pattern={row.unit === 'un' ? '[0-9]+' : '[0-9]+([,.][0-9]{1,6})?'} required/></label>
          <label>Modalidade <select name="method" required>
            <option value="">Selecione</option><option value="ENTREGA">Entrega</option><option value="RETIRADA">Retirada</option>
          </select></label>
          <label>Observações do despacho <textarea name="notes" maxLength={500} rows={2}/></label>
          <button disabled={busy}>Confirmar despacho e baixa</button>
        </form>
      </details> : <p role="status">O lote ou local está inelegível para despacho. A reserva precisa ser revista.</p>}
    </article>)}
    {queue.data && (queue.data.total > pageSize || page > 0) && <nav aria-label="Páginas da fila de expedição">
      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
      <span>Página {page + 1} · {queue.data.total} reservas</span>
      <button type="button" disabled={(page + 1) * pageSize >= queue.data.total} onClick={() => setPage(page + 1)}>Próxima</button>
    </nav>}
    </>}
  </section>
}
