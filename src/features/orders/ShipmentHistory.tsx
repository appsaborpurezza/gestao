import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { Badge } from '../../ui'
import { DataTable, type Column } from '../../ui/DataTable'
import { FilterBar } from '../../ui/filters'

type Shipment = {
  id: string; order_number: number; customer_name: string; delivery_date: string
  description: string; unit: string; internal_code: string; location_code: string
  quantity: string; method: 'ENTREGA' | 'RETIRADA'; notes: string | null
  dispatched_at: string; delivered_at: string | null; delivery_reference: string | null
  returnable: string; returned_lots: { code: string; quantity: string }[]
}
const localDateTime = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short',
})
const stamp = (value: string) => localDateTime.format(new Date(value))

function DeliveryForm({ shipment, onConfirmed }: { shipment: Shipment; onConfirmed: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const request = useRef<{ fingerprint: string; id: string } | null>(null)

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const fields = new FormData(event.currentTarget)
    const payload = {
      target_shipment: shipment.id,
      actual_local: fields.get('actual') || null,
      reference: fields.get('reference') || null,
    }
    const fingerprint = JSON.stringify(payload)
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.rpc('confirm_delivery', { ...payload, request_id: request.current.id })
      if (error) throw new Error(error.message)
      onConfirmed()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao confirmar o recebimento.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const noun = shipment.method === 'RETIRADA' ? 'retirada' : 'entrega'
  return <details open><summary>Confirmar {noun}</summary>
    <form className="ui-inline-form" onSubmit={confirm}>
      <label>Data e hora da {noun} (São Paulo)
        <input name="actual" type="datetime-local" aria-describedby={'help-' + shipment.id}/>
      </label>
      <label>Referência do comprovante <input name="reference" maxLength={300}/></label>
      <div><button disabled={busy}>{busy ? 'Registrando…' : 'Registrar ' + noun}</button></div>
    </form>
    <p className="ui-muted" id={'help-' + shipment.id}>Deixe a data em branco para registrar o horário atual.</p>
    {error && <p className="ui-message" data-tone="danger" role="alert">{error}</p>}
  </details>
}

function ReturnForm({ shipment, locations, locationsUnavailable, onReturned }: {
  shipment: Shipment; locations: { id: string; code: string }[]; locationsUnavailable: boolean; onReturned: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const request = useRef<{ fingerprint: string; id: string } | null>(null)

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const payload = {
      target_shipment: shipment.id,
      target_location: fields.get('location'),
      amount: String(fields.get('amount')).replace(',', '.'),
      reason: fields.get('reason'),
    }
    const fingerprint = JSON.stringify(payload)
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.rpc('register_shipment_return', { ...payload, request_id: request.current.id })
      if (error) throw new Error(error.message)
      form.reset()
      request.current = null
      onReturned()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao registrar devolução.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <details><summary>Registrar devolução</summary>
    <p className="ui-muted">Quantidade ainda devolvível: {formatStockQuantity(shipment.returnable)} {shipment.unit}.</p>
    {locationsUnavailable && <p className="ui-message" data-tone="danger" role="alert">Falha ao consultar locais de estoque.</p>}
    {!locationsUnavailable && !locations.length && <p className="ui-message">Nenhum local ativo disponível.</p>}
    <form className="ui-inline-form" onSubmit={register}>
      <label>Local físico de quarentena <select name="location" required>
        <option value="">Selecione</option>{locations.map(location => <option key={location.id} value={location.id}>{location.code}</option>)}
      </select></label>
      <label>Quantidade devolvida ({shipment.unit}) <input name="amount" inputMode="decimal"
        pattern={shipment.unit === 'un' ? '[0-9]+' : '[0-9]+([,.][0-9]{1,6})?'} required/></label>
      <label>Motivo <input name="reason" maxLength={500} required/></label>
      <div><button disabled={busy || !locations.length}>{busy ? 'Registrando…' : 'Receber em quarentena'}</button></div>
    </form>
    {error && <p className="ui-message" data-tone="danger" role="alert">{error}</p>}
  </details>
}

export function ShipmentHistory({ allowConfirmation }: { allowConfirmation: boolean }) {
  const cache = useQueryClient()
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [pendingOnly, setPendingOnly] = useState(false)
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const history = useQuery({
    queryKey: ['shipping', 'history', pendingOnly, page, pageSize],
    placeholderData: previous => previous,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('shipment_history', {
        pending_only: pendingOnly, page_size: pageSize, page_offset: page * pageSize,
      })
      if (error) throw error
      return data as { total: number; rows: Shipment[] }
    },
  })
  const locations = useQuery({
    queryKey: ['shipping', 'return-locations'],
    enabled: allowConfirmation,
    queryFn: async () => {
      const { data, error } = await supabase.from('locations').select('id,code').eq('active', true).order('code')
      if (error) throw error
      return data
    },
  })
  const setPending = (value: boolean) => { setPendingOnly(value); setPage(0); setNotice(''); setSelected(null) }
  const open = (row: Shipment) => { setSelected(row.id); setNotice('') }
  const methodLabel = (row: Shipment) => row.method === 'RETIRADA' ? 'Retirada' : 'Entrega'
  const columns: Column<Shipment>[] = [
    { id: 'order', header: 'Pedido', cell: row => <span className="ui-cell-stack"><strong>Pedido {row.order_number}</strong><span>{row.customer_name}</span></span> },
    { id: 'product', header: 'Produto', cell: row => <span className="ui-cell-stack"><span>{row.description}</span><span>{formatStockQuantity(row.quantity)} {row.unit}</span></span> },
    { id: 'lot', header: 'Lote e local', optional: true, cell: row => <span className="ui-cell-stack"><span className="ui-code">{row.internal_code}</span><span>{row.location_code}</span></span> },
    { id: 'dispatched', header: 'Despacho', cell: row => <span className="ui-cell-stack"><span>{stamp(row.dispatched_at)}</span><span>{methodLabel(row)}</span></span> },
    { id: 'status', header: 'Situação', cell: row => <span className="ui-cell-stack">
      {row.delivered_at ? <Badge tone="success">{row.method === 'RETIRADA' ? 'Retirada confirmada' : 'Entregue'}</Badge>
        : <Badge tone="warning">{row.method === 'RETIRADA' ? 'Aguardando retirada' : 'Aguardando entrega'}</Badge>}
      {row.returned_lots.length > 0 && <Badge tone="info">Com devolução</Badge>}
    </span> },
  ]
  const stale = history.isPlaceholderData
  const shipment = history.data?.rows.find(row => row.id === selected)

  return <section aria-labelledby="shipment-history-title">
    <h2 id="shipment-history-title" className="sr-only">Histórico de expedições</h2>
    <FilterBar activeCount={pendingOnly ? 1 : 0} onClear={() => setPending(false)}
      onRefresh={() => void history.refetch()} refreshing={history.isFetching}>
      <label className="ui-check"><input type="checkbox" checked={pendingOnly}
        onChange={event => setPending(event.target.checked)}/> Somente entregas ou retiradas pendentes</label>
    </FilterBar>
    {notice && <p className="ui-message" data-tone="success" role="status">{notice}</p>}
    {shipment && <article className="ui-detail" aria-labelledby="shipment-title">
      <div className="ui-detail-header">
        <div>
          <h3 id="shipment-title">Pedido {shipment.order_number} · {shipment.customer_name}</h3>
          <p className="ui-muted">{shipment.description} · {formatStockQuantity(shipment.quantity)} {shipment.unit}</p>
        </div>
        <button type="button" className="secondary" onClick={() => setSelected(null)}><X aria-hidden="true" size={16}/>Fechar</button>
      </div>
      <dl>
        <div><dt>Lote</dt><dd className="ui-code">{shipment.internal_code}</dd></div>
        <div><dt>Local</dt><dd>{shipment.location_code}</dd></div>
        <div><dt>Despachado em</dt><dd>{stamp(shipment.dispatched_at)} · {methodLabel(shipment)}</dd></div>
        <div><dt>Previsão do pedido</dt><dd>{shipment.delivery_date.split('-').reverse().join('/')}</dd></div>
        {shipment.delivered_at && <div><dt>{shipment.method === 'RETIRADA' ? 'Retirada confirmada' : 'Entrega confirmada'}</dt><dd>{stamp(shipment.delivered_at)}</dd></div>}
        {shipment.delivery_reference && <div><dt>Comprovante</dt><dd>{shipment.delivery_reference}</dd></div>}
      </dl>
      {shipment.notes && <p>{shipment.notes}</p>}
      {shipment.returned_lots.length > 0 && <ul aria-label="Devoluções registradas">
        {shipment.returned_lots.map(row => <li key={row.code}>
          Devolvido: {formatStockQuantity(row.quantity)} {shipment.unit} · Lote <span className="ui-code">{row.code}</span>
        </li>)}
      </ul>}
      {!shipment.delivered_at && allowConfirmation && <DeliveryForm key={shipment.id} shipment={shipment} onConfirmed={() => {
        setNotice(shipment.method === 'RETIRADA' ? 'Retirada confirmada.' : 'Entrega confirmada.')
        void cache.invalidateQueries({ queryKey: ['shipping', 'history'] })
      }}/>}
      {allowConfirmation && Number(shipment.returnable) > 0 && <ReturnForm key={'return-' + shipment.id} shipment={shipment}
        locations={locations.data ?? []} locationsUnavailable={locations.isError} onReturned={() => {
          setNotice('Devolução registrada em quarentena.')
          void cache.invalidateQueries({ queryKey: ['shipping', 'history'] })
          void cache.invalidateQueries({ queryKey: ['inventory'] })
        }}/>}
    </article>}
    <DataTable caption="Histórico de expedições" rows={stale ? undefined : history.data?.rows} columns={columns} rowKey={row => row.id}
      loading={history.isFetching} error={history.isError} onRetry={() => void history.refetch()}
      total={history.data?.total ?? 0} page={page} pageSize={pageSize} onPageChange={setPage}
      onPageSizeChange={size => { setPageSize(size); setPage(0) }} preferenceKey="shipment-history"
      filtered={pendingOnly} onClearFilters={() => setPending(false)}
      empty={{ title: 'Nenhuma expedição registrada', description: 'Os despachos confirmados na fila aparecem aqui.' }}
      onRowOpen={open}
      rowActions={row => <button type="button" className="secondary" onClick={() => open(row)}>
        {allowConfirmation && !row.delivered_at ? 'Confirmar' : 'Detalhes'}</button>}/>
  </section>
}
