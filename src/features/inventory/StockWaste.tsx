import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { useLossMutation, useLossOptions } from '../production/lossSupport'

const categories = {
  INSUMO: 'Insumo', EMBALAGEM: 'Embalagem', VENCIMENTO_ACABADO: 'Acabado vencido', OUTRO_ACABADO: 'Outra perda de acabado',
} as const
type Category = keyof typeof categories
const todayLocal = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())
const dateTime = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short',
})
const pageSize = 20

export function StockWasteDetails({ lotId, unit, classification, locations }: {
  lotId: string; unit: string; classification: string; locations: { id: string; code: string }[]
}) {
  const [open, setOpen] = useState(false)
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Descartar saldo físico</summary>
    {open && <StockWasteForm lotId={lotId} unit={unit} classification={classification} locations={locations}/>}
  </details>
}

function StockWasteForm({ lotId, unit, classification, locations }: {
  lotId: string; unit: string; classification: string; locations: { id: string; code: string }[]
}) {
  const options = useLossOptions()
  const mutation = useLossMutation('discard_stock')
  const allowed: Category[] = classification === 'INSUMO' ? ['INSUMO','EMBALAGEM']
    : classification === 'FARINHA_USO_REVENDA_A_VALIDAR' ? ['INSUMO','VENCIMENTO_ACABADO','OUTRO_ACABADO']
      : ['VENCIMENTO_ACABADO','OUTRO_ACABADO']

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    void mutation.run({ input: {
      lot_id: lotId, location_id: fields.get('location'), category: fields.get('category'),
      quantity: String(fields.get('quantity')).replace(',', '.'), reason_id: fields.get('reason'),
      destination_id: fields.get('destination'), notes: fields.get('notes'),
    } }, form, 'Descarte registrado e saldo físico atualizado.')
  }

  return <>
    <p>Use esta ação para material que ainda consta no saldo físico do lote.</p>
    {options.isPending && <p role="status">Carregando motivos e destinações…</p>}
    {options.isError && <p role="alert">Falha ao carregar os cadastros de perdas.</p>}
    {options.data?.destinations.length === 0 && <p>Cadastre uma destinação autorizada em Desperdícios.</p>}
    {locations.length === 0 && <p>Nenhum saldo físico disponível para descarte.</p>}
    {!!locations.length && !!options.data?.destinations.length && <form onSubmit={submit}>
      <label>Local <select name="location" required><option value="">Selecione</option>
        {locations.map(row => <option key={row.id} value={row.id}>{row.code}</option>)}
      </select></label>
      <label>Categoria da perda <select name="category" required><option value="">Selecione</option>
        {allowed.map(key => <option key={key} value={key}>{categories[key]}</option>)}
      </select></label>
      <label>Quantidade descartada ({unit}) <input name="quantity" inputMode="decimal"
        pattern={unit === 'un' ? '[0-9]+' : '[0-9]+([,.][0-9]{1,6})?'} required/></label>
      <label>Motivo <select name="reason" required><option value="">Selecione</option>
        {options.data.reasons.filter(row => row.active).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></label>
      <label>Destinação autorizada <select name="destination" required><option value="">Selecione</option>
        {options.data.destinations.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></label>
      <label>Observações <textarea name="notes" maxLength={500} rows={2}/></label>
      <button disabled={mutation.busy}>{mutation.busy ? 'Registrando…' : 'Confirmar descarte e baixa'}</button>
    </form>}
    {mutation.feedback && <p role={mutation.feedback.error ? 'alert' : 'status'}>{mutation.feedback.text}</p>}
  </>
}

type Total = { category: Category; unit: string; quantity: string }
type Report = {
  total: number; totals: Total[]
  rows: (Total & { id: string; description: string; internal_code: string; location_code: string
    reason: string; destination: string; notes: string | null; discarded_at: string; operator: string; lot_status: string })[]
}

export function StockWasteHistory() {
  const today = todayLocal()
  const [filter, setFilter] = useState({ from_day: today, to_day: today, filter_category: null as string | null })
  const [page, setPage] = useState(0)
  const history = useQuery({
    queryKey: ['losses', 'stock-history', filter, page],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('stock_waste_history', { ...filter, page_size: pageSize, page_offset: page * pageSize })
      if (error) throw error
      return data as Report
    },
  })
  return <section>
    <h2>Descartes de estoque</h2>
    <form onSubmit={event => {
      event.preventDefault()
      const fields = new FormData(event.currentTarget)
      setPage(0)
      setFilter({ from_day: String(fields.get('from')), to_day: String(fields.get('to')),
        filter_category: String(fields.get('category') ?? '') || null })
    }}>
      <div className="customer-fields">
        <label>De <input name="from" type="date" defaultValue={today} max={today} required/></label>
        <label>Até <input name="to" type="date" defaultValue={today} max={today} required/></label>
        <label>Categoria <select name="category"><option value="">Todas</option>
          {Object.entries(categories).map(([key,label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
      </div>
      <button>Consultar descartes</button>
    </form>
    {history.isPending && <p role="status">Carregando descartes…</p>}
    {history.isError && <p role="alert">Falha ao consultar descartes. Confira o período.</p>}
    {history.data?.total === 0 && <p>Nenhum descarte no período.</p>}
    {history.data && <>
      {!!history.data.totals.length && <ul aria-label="Totais por categoria e unidade">
        {history.data.totals.map(row => <li key={row.category + '/' + row.unit}>
          {categories[row.category]} · {formatStockQuantity(row.quantity)} {row.unit}
        </li>)}
      </ul>}
      {history.data.rows.map(row => <article key={row.id}>
        <h3>{row.description} · {formatStockQuantity(row.quantity)} {row.unit}</h3>
        <p className="break-code">{row.internal_code} · {row.location_code} · {row.lot_status}</p>
        <p>{categories[row.category]} · {row.reason} · {row.destination}</p>
        <p>{dateTime.format(new Date(row.discarded_at))} · {row.operator}</p>
        {row.notes && <p>{row.notes}</p>}
      </article>)}
      {(history.data.total > pageSize || page > 0) && <nav aria-label="Páginas de descartes">
        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
        <span>Página {page + 1} · {history.data.total} registros</span>
        <button type="button" disabled={(page + 1) * pageSize >= history.data.total} onClick={() => setPage(page + 1)}>Próxima</button>
      </nav>}
    </>}
  </section>
}
