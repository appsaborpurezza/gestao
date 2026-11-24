import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'

type Shipment = {
  id: string; order_number: number; customer_name: string; delivery_date: string
  description: string; unit: string; internal_code: string; location_code: string
  quantity: string; method: 'ENTREGA' | 'RETIRADA'; notes: string | null
  dispatched_at: string; delivered_at: string | null; delivery_reference: string | null
  returnable: string; returned_lots: { code: string; quantity: string }[]
}
const pageSize = 20
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
  return <details><summary>Confirmar {noun}</summary>
    <form onSubmit={confirm}>
      <label>Data e hora da {noun} (São Paulo)
        <input name="actual" type="datetime-local" aria-describedby={'help-' + shipment.id}/>
      </label>
      <p id={'help-' + shipment.id}>Deixe em branco para registrar o horário atual.</p>
      <label>Referência do comprovante <input name="reference" maxLength={300}/></label>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy}>{busy ? 'Registrando…' : 'Registrar ' + noun}</button>
    </form>
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
    <p>Quantidade ainda devolvível: {formatStockQuantity(shipment.returnable)} {shipment.unit}.</p>
    {locationsUnavailable && <p role="alert">Falha ao consultar locais de estoque.</p>}
    {!locationsUnavailable && !locations.length && <p>Nenhum local ativo disponível.</p>}
    <form onSubmit={register}>
      <label>Local físico de quarentena <select name="location" required>
        <option value="">Selecione</option>{locations.map(location => <option key={location.id} value={location.id}>{location.code}</option>)}
      </select></label>
      <label>Quantidade devolvida ({shipment.unit}) <input name="amount" inputMode="decimal"
        pattern={shipment.unit === 'un' ? '[0-9]+' : '[0-9]+([,.][0-9]{1,6})?'} required/></label>
      <label>Motivo <input name="reason" maxLength={500} required/></label>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy || !locations.length}>{busy ? 'Registrando…' : 'Receber em quarentena'}</button>
    </form>
  </details>
}

export function ShipmentHistory({ allowConfirmation }: { allowConfirmation: boolean }) {
  const cache = useQueryClient()
  const [page, setPage] = useState(0)
  const [pendingOnly, setPendingOnly] = useState(false)
  const [notice, setNotice] = useState('')
  const history = useQuery({
    queryKey: ['shipping', 'history', pendingOnly, page],
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

  return <section>
    <h2>Histórico de expedições</h2>
    <label className="customer-check"><input type="checkbox" checked={pendingOnly} onChange={event => {
      setPendingOnly(event.target.checked)
      setPage(0)
      setNotice('')
    }}/> Somente entregas ou retiradas pendentes</label>
    {notice && <p role="status">{notice}</p>}
    {history.isPending && <p role="status">Carregando histórico…</p>}
    {history.isError && <p role="alert">Falha ao consultar o histórico de expedição.</p>}
    {history.data?.rows.length === 0 && <p>Nenhuma expedição nesta página.</p>}
    {history.data?.rows.map(shipment => <article key={shipment.id}>
      <h3>Pedido {shipment.order_number} · {shipment.customer_name}</h3>
      <p>{shipment.description} · {formatStockQuantity(shipment.quantity)} {shipment.unit}</p>
      <p>Lote {shipment.internal_code} · Local {shipment.location_code}</p>
      <p>Despachado em {stamp(shipment.dispatched_at)} · {shipment.method === 'RETIRADA' ? 'Retirada' : 'Entrega'}</p>
      <p>Previsão do pedido {shipment.delivery_date.split('-').reverse().join('/')}</p>
      {shipment.notes && <p>{shipment.notes}</p>}
      {shipment.delivered_at ? <>
        <p>{shipment.method === 'RETIRADA' ? 'Retirada confirmada' : 'Entrega confirmada'} em {stamp(shipment.delivered_at)}.</p>
        {shipment.delivery_reference && <p>Comprovante: {shipment.delivery_reference}</p>}
      </> : <>
        <p>{shipment.method === 'RETIRADA' ? 'Aguardando retirada' : 'Aguardando entrega'}</p>
        {allowConfirmation && <DeliveryForm shipment={shipment} onConfirmed={() => {
          setNotice(shipment.method === 'RETIRADA' ? 'Retirada confirmada.' : 'Entrega confirmada.')
          void cache.invalidateQueries({ queryKey: ['shipping', 'history'] })
        }}/>}
      </>}
      {shipment.returned_lots.length > 0 && <ul aria-label="Devoluções registradas">
        {shipment.returned_lots.map(row => <li key={row.code}>
          Devolvido: {formatStockQuantity(row.quantity)} {shipment.unit} · Lote {row.code}
        </li>)}
      </ul>}
      {allowConfirmation && Number(shipment.returnable) > 0 && <ReturnForm shipment={shipment}
        locations={locations.data ?? []} locationsUnavailable={locations.isError} onReturned={() => {
          setNotice('Devolução registrada em quarentena.')
          void cache.invalidateQueries({ queryKey: ['shipping', 'history'] })
          void cache.invalidateQueries({ queryKey: ['inventory'] })
        }}/>}
    </article>)}
    {history.data && (history.data.total > pageSize || page > 0) && <nav aria-label="Páginas do histórico">
      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
      <span>Página {page + 1} · {history.data.total} expedições</span>
      <button type="button" disabled={(page + 1) * pageSize >= history.data.total} onClick={() => setPage(page + 1)}>Próxima</button>
    </nav>}
  </section>
}
