import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PackageX } from 'lucide-react'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { Badge, StatCard } from '../../ui'
import { DataTable, type Column } from '../../ui/DataTable'
import { FilterBar } from '../../ui/filters'
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
    <p className="ui-muted">Use esta ação para material que ainda consta no saldo físico do lote.</p>
    {options.isPending && <p role="status">Carregando motivos e destinações…</p>}
    {options.isError && <p className="ui-message" data-tone="danger" role="alert">Falha ao carregar os cadastros de perdas.</p>}
    {options.data?.destinations.length === 0 && <p className="ui-message">Cadastre uma destinação autorizada em Desperdícios.</p>}
    {locations.length === 0 && <p className="ui-message">Nenhum saldo físico disponível para descarte.</p>}
    {!!locations.length && !!options.data?.destinations.length && <form className="ui-inline-form" onSubmit={submit}>
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
      <div><button disabled={mutation.busy}>{mutation.busy ? 'Registrando…' : 'Confirmar descarte e baixa'}</button></div>
    </form>}
    {mutation.feedback && <p className="ui-message" data-tone={mutation.feedback.error ? 'danger' : 'success'} role={mutation.feedback.error ? 'alert' : 'status'}>{mutation.feedback.text}</p>}
  </>
}

type Total = { category: Category; unit: string; quantity: string }
type Report = {
  total: number; totals: Total[]
  rows: (Total & { id: string; description: string; internal_code: string; location_code: string
    reason: string; destination: string; notes: string | null; discarded_at: string; operator: string; lot_status: string })[]
}

type WasteRow = Report['rows'][number]

export function StockWasteHistory() {
  const today = todayLocal()
  const initial = { from_day: today, to_day: today, filter_category: null as string | null }
  const [filter, setFilter] = useState(initial)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const validPeriod = !!filter.from_day && !!filter.to_day && filter.from_day <= filter.to_day
  const history = useQuery({
    queryKey: ['losses', 'stock-history', filter, page, pageSize],
    enabled: validPeriod,
    placeholderData: previous => previous,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('stock_waste_history', { ...filter, page_size: pageSize, page_offset: page * pageSize })
      if (error) throw error
      return data as Report
    },
  })
  const update = (next: Partial<typeof filter>) => { setFilter({ ...filter, ...next }); setPage(0) }
  const activeFilters = Number(filter.from_day !== today || filter.to_day !== today) + Number(!!filter.filter_category)
  const columns: Column<WasteRow>[] = [
    { id: 'when', header: 'Descarte', cell: row => <span className="ui-cell-stack"><span>{dateTime.format(new Date(row.discarded_at))}</span><span>{row.operator}</span></span> },
    { id: 'item', header: 'Item', cell: row => <span className="ui-cell-stack"><strong>{row.description}</strong><span className="ui-code">{row.internal_code}</span></span> },
    { id: 'quantity', header: 'Quantidade', align: 'end', cell: row => <strong>{formatStockQuantity(row.quantity)} {row.unit}</strong> },
    { id: 'category', header: 'Categoria', cell: row => <Badge>{categories[row.category]}</Badge> },
    { id: 'reason', header: 'Motivo e destinação', cell: row => <span className="ui-cell-stack"><span>{row.reason}</span><span>{row.destination}</span></span> },
    { id: 'location', header: 'Local', optional: true, cell: row => row.location_code },
    { id: 'lot', header: 'Status do lote', optional: true, hiddenByDefault: true, cell: row => row.lot_status },
    { id: 'notes', header: 'Observações', optional: true, hiddenByDefault: true, cell: row => row.notes ?? '—' },
  ]
  const stale = history.isPlaceholderData

  return <section aria-labelledby="stock-waste-title">
    <h2 id="stock-waste-title" className="sr-only">Descartes de estoque</h2>
    <FilterBar activeCount={activeFilters} onClear={() => update(initial)}
      onRefresh={() => void history.refetch()} refreshing={history.isFetching}>
      <label>De <input type="date" value={filter.from_day} max={filter.to_day || today} required
        onChange={event => update({ from_day: event.target.value })}/></label>
      <label>Até <input type="date" value={filter.to_day} min={filter.from_day} max={today} required
        onChange={event => update({ to_day: event.target.value })}/></label>
      <label>Categoria <select value={filter.filter_category ?? ''} onChange={event => update({ filter_category: event.target.value || null })}>
        <option value="">Todas</option>
        {Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
    </FilterBar>
    {!validPeriod && <p className="ui-message" data-tone="danger" role="alert">Informe um período válido: a data inicial não pode ser posterior à final.</p>}
    {history.data && !stale && !!history.data.totals.length && <div className="ui-stat-grid" aria-label="Totais por categoria e unidade">
      {history.data.totals.map(row => <StatCard key={row.category + '/' + row.unit} icon={PackageX}
        label={categories[row.category]} value={formatStockQuantity(row.quantity)} unit={row.unit}/>)}
    </div>}
    <DataTable caption="Descartes de estoque" rows={!validPeriod ? [] : stale ? undefined : history.data?.rows} columns={columns}
      rowKey={row => row.id} loading={history.isFetching} error={history.isError} onRetry={() => void history.refetch()}
      total={validPeriod ? history.data?.total ?? 0 : 0} page={page} pageSize={pageSize} onPageChange={setPage}
      onPageSizeChange={size => { setPageSize(size); setPage(0) }} preferenceKey="stock-waste"
      filtered={activeFilters > 0} onClearFilters={() => update(initial)}
      empty={{ title: 'Nenhum descarte no período', description: 'Descartes são registrados no detalhe do lote, em Estoque.' }}/>
  </section>
}
