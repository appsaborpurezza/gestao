import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Truck, X } from 'lucide-react'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { Badge, PageHeader } from '../../ui'
import { DataTable, type Column } from '../../ui/DataTable'
import { Tabs } from '../../ui/Tabs'
import { ShipmentHistory } from './ShipmentHistory'

type QueueRow = {
  id: string; order_number: number; customer_name: string; delivery_date: string; description: string
  unit: string; internal_code: string; location_code: string; remaining: string; eligible: boolean
}
const brDate = (value: string) => value.split('-').reverse().join('/')

export function Shipping({ allowOperations }: { allowOperations: boolean }) {
  const [view, setView] = useState<'queue' | 'history'>(allowOperations ? 'queue' : 'history')
  const cache = useQueryClient()
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null)
  const pending = useRef(new Map<string, string>())
  const inFlight = useRef(false)
  const queue = useQuery({
    queryKey: ['shipping', 'queue', page, pageSize],
    placeholderData: previous => previous,
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
      setSelected(null)
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

  const columns: Column<QueueRow>[] = [
    { id: 'order', header: 'Pedido', cell: row => <span className="ui-cell-stack"><strong>Pedido {row.order_number}</strong><span>{row.customer_name}</span></span> },
    { id: 'product', header: 'Produto', cell: row => row.description },
    { id: 'lot', header: 'Lote e local', cell: row => <span className="ui-cell-stack"><span className="ui-code">{row.internal_code}</span><span>{row.location_code}</span></span> },
    { id: 'quantity', header: 'Reservado', align: 'end', cell: row => formatStockQuantity(row.remaining) + ' ' + row.unit },
    { id: 'delivery', header: 'Entrega prevista', cell: row => brDate(row.delivery_date) },
    { id: 'status', header: 'Situação', cell: row => row.eligible ? <Badge tone="success">Pronto para despacho</Badge> : <Badge tone="danger">Rever reserva</Badge> },
  ]
  const stale = queue.isPlaceholderData
  const current = queue.data?.rows.find(row => row.id === selected)
  const operating = allowOperations && view === 'queue'

  return <section className="panel">
    <PageHeader icon={Truck} title="Expedição"
      description={operating ? 'Confira cada reserva, registre o despacho e dê baixa no saldo físico.' : 'Despachos realizados, confirmação de entrega ou retirada e devoluções.'}/>
    {allowOperations && <Tabs label="Expedição" value={view} onChange={next => { setView(next); setFeedback(null) }} items={[
      { id: 'queue', label: 'Fila de despacho' }, { id: 'history', label: 'Histórico' },
    ]}/>}
    {!operating ? <ShipmentHistory allowConfirmation={allowOperations}/> : <>
    {feedback && <p className="ui-message" data-tone={feedback.error ? 'danger' : 'success'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {current && <article className="ui-detail" aria-labelledby="dispatch-title">
      <div className="ui-detail-header">
        <div>
          <h2 id="dispatch-title">Pedido {current.order_number} · {current.customer_name}</h2>
          <p className="ui-muted">{current.description} · entrega prevista em {brDate(current.delivery_date)}</p>
        </div>
        <button type="button" className="secondary" onClick={() => setSelected(null)}><X aria-hidden="true" size={16}/>Fechar</button>
      </div>
      <dl>
        <div><dt>Lote</dt><dd className="ui-code">{current.internal_code}</dd></div>
        <div><dt>Local</dt><dd>{current.location_code}</dd></div>
        <div><dt>Reservado</dt><dd>{formatStockQuantity(current.remaining)} {current.unit}</dd></div>
      </dl>
      {current.eligible ? <form className="ui-inline-form" onSubmit={event => void dispatch(event, current)}>
        <label>Quantidade despachada ({current.unit}) <input name="amount" inputMode="decimal"
          pattern={current.unit === 'un' ? '[0-9]+' : '[0-9]+([,.][0-9]{1,6})?'} required/></label>
        <label>Modalidade <select name="method" required>
          <option value="">Selecione</option><option value="ENTREGA">Entrega</option><option value="RETIRADA">Retirada</option>
        </select></label>
        <label>Observações do despacho <textarea name="notes" maxLength={500} rows={2}/></label>
        <div><button disabled={busy}>{busy ? 'Registrando…' : 'Confirmar despacho e baixa'}</button></div>
      </form> : <p className="ui-message" data-tone="danger" role="status">O lote ou local está inelegível para despacho. A reserva precisa ser revista.</p>}
    </article>}
    <DataTable caption="Fila de despacho" rows={stale ? undefined : queue.data?.rows} columns={columns} rowKey={row => row.id}
      loading={queue.isFetching} error={queue.isError} onRetry={() => void queue.refetch()}
      total={queue.data?.total ?? 0} page={page} pageSize={pageSize} onPageChange={setPage}
      onPageSizeChange={size => { setPageSize(size); setPage(0) }}
      empty={{ title: 'Nenhuma reserva aguardando despacho', description: 'Reservas confirmadas nos pedidos aparecem aqui para conferência.' }}
      onRowOpen={row => { setSelected(row.id); setFeedback(null) }}
      rowActions={row => <button type="button" className="secondary" onClick={() => { setSelected(row.id); setFeedback(null) }}>
        {row.eligible ? 'Despachar' : 'Ver'}</button>}/>
    </>}
  </section>
}
