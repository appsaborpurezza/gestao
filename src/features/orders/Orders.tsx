import { useRef, useState, type FormEvent } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, FileText, Plus, ShoppingCart } from 'lucide-react'
import { DataTable, type Column, type SortState } from '../../ui/DataTable'
import { FilterBar, PeriodFilter, SearchInput, useDebouncedValue, useSessionState } from '../../ui/filters'
import { SavedViews } from '../../ui/SavedViews'
import { resolvePeriod } from '../../lib/periods'
import { Badge, ErrorState, PageHeader, Skeleton } from '../../ui'
import { todayInSaoPaulo } from '../../lib/periods'
import { supabase } from '../../lib/supabase'
import { normalizeText } from '../../lib/text'
import { formatBrl as currency, formatStockQuantity } from '../../lib/decimal'
import { OrderBilling } from './OrderBilling'
import { CommercialDocumentButton, CommercialDocumentSettings } from './CommercialDocument'
import { OrderReservations } from './OrderReservations'
import { Combobox } from '../../ui/Combobox'
const date = (value: string | null) => value?.split('-').reverse().join('/') ?? 'A definir'
const statuses: Record<string, string> = { RASCUNHO: 'Rascunho', CONFIRMADO: 'Confirmado', PARCIAL: 'Parcial', EXPEDIDO: 'Expedido' }
const statusTone: Record<string, 'neutral' | 'info' | 'warning' | 'success'> = { RASCUNHO: 'neutral', CONFIRMADO: 'info', PARCIAL: 'warning', EXPEDIDO: 'success' }
type ListRow = { id: string; order_number: number; customer_name: string; delivery_date: string | null; fulfillment_status: string; issued_at: string }

/** Situação do prazo: atraso só para pedidos ainda em atendimento (não confunde com prioridade). */
export function deadlineState(row: Pick<ListRow, 'delivery_date' | 'fulfillment_status'>, today: string) {
  if (!row.delivery_date || row.fulfillment_status === 'EXPEDIDO' || row.fulfillment_status === 'RASCUNHO') return null
  if (row.delivery_date < today) return 'late'
  const limit = new Date(today + 'T00:00:00Z')
  limit.setUTCDate(limit.getUTCDate() + 2)
  return row.delivery_date <= limit.toISOString().slice(0, 10) ? 'soon' : 'ok'
}
const emptyFilters = { term: '', status: '', period: { from: '', to: '', preset: '' }, page: 0, pageSize: 25,
  sort: { column: 'order_number', direction: 'desc' } as SortState }

type Product = { id: string; original_code: string; original_description: string; base_unit: string }
type Client = { id: string; legal_name: string; customer_number: number }
type Financial = {
  total: string; billed_total: string; billing_status: string; payment_terms: string | null
  payment_due_date: string | null; commercial_notes: string | null
}
type OrderLine = {
  id: string; item_id: string; line_number: number; item_code: string; description: string; quantity: string; unit: string
  confirmed_classification: string | null
  order_item_financials: { unit_price: string; discount: string; total: string } | null
}
type Draft = {
  id: string; version: number; customer_id: string; customer_name: string; order_number: number
  fulfillment_status: string; delivery_date: string | null; operational_notes: string | null
  finance: Financial | null; lines: OrderLine[]
}

async function readOptions<T>(read: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const options: T[] = []
  const batchSize = 200
  for (let offset = 0; ; offset += batchSize) {
    const { data, error } = await read(offset, offset + batchSize - 1)
    if (error) throw error
    if (!data) throw new Error('Falha ao carregar as opções do pedido.')
    options.push(...data)
    if (data.length < batchSize) return options
  }
}

function DraftForm({ products, customers, onClose, onSaved, draft }: {
  products: Product[]; customers: Client[]; onClose: () => void; onSaved: (id: string) => void; draft?: Draft
}) {
  const [rows, setRows] = useState<{ key: string; product: string; line?: OrderLine }[]>(() => draft
    ? [...draft.lines].sort((a, b) => a.line_number - b.line_number)
      .map(line => ({ key: crypto.randomUUID(), product: line.item_id, line }))
    : [{ key: crypto.randomUUID(), product: '', line: undefined }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [customerId, setCustomerId] = useState(draft?.customer_id ?? '')
  const pending = useRef<{ fingerprint: string; id: string } | null>(null)
  const inFlight = useRef(false)
  const cache = useQueryClient()

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const form = new FormData(event.currentTarget)
    const decimal = (key: string) => String(form.get(key) ?? '').replace(',', '.')
    const input = {
      customer_id: form.get('customer_id'),
      delivery_date: form.get('delivery_date'),
      payment_terms: form.get('payment_terms'),
      payment_due_date: form.get('payment_due_date'),
      operational_notes: form.get('operational_notes'),
      commercial_notes: form.get('commercial_notes'),
      items: rows.map(row => ({
        item_id: row.product,
        unit: row.line?.item_id === row.product ? row.line.unit
          : products.find(product => product.id === row.product)?.base_unit,
        quantity: decimal('quantity-' + row.key),
        unit_price: decimal('price-' + row.key),
        discount: decimal('discount-' + row.key) || '0',
      })),
    }
    const fingerprint = JSON.stringify(input)
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const params = { input, request_id: pending.current.id }
      const { data, error } = draft
        ? await supabase.rpc('edit_order_draft', { ...params, target_order: draft.id, expected_version: draft.version })
        : await supabase.rpc('create_order_draft', params)
      if (error) throw new Error(error.code === '22003' ? 'Confira os valores do pedido.' : error.message)
      await cache.invalidateQueries({ queryKey: ['orders'] })
      onSaved(data as string)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao salvar o pedido.')
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  return <section>
    <h2>{draft ? 'Editar pedido ' + draft.order_number : 'Novo rascunho'}</h2>
    {(!customers.length || !products.length) ? <>
      <p>Cadastre um cliente ativo e configure a unidade base de pelo menos um produto para criar pedidos.</p>
      <button onClick={onClose}>Voltar</button>
    </> : <form onSubmit={submit}>
      <div className="customer-fields">
        <Combobox label="Cliente" name="customer_id" required value={customerId} onChange={setCustomerId}
          options={[
            ...(draft && !customers.some(customer => customer.id === draft.customer_id)
              ? [{ value: draft.customer_id, label: draft.customer_name + ' · Inativo', disabled: true }] : []),
            ...customers.map(customer => ({ value: customer.id, label: customer.legal_name, hint: 'Código ' + customer.customer_number })),
          ]}/>
        <label>Previsão de entrega <input name="delivery_date" type="date" defaultValue={draft?.delivery_date ?? ''}/></label>
        <label>Condição de pagamento <input name="payment_terms" maxLength={254} defaultValue={draft?.finance?.payment_terms ?? ''}/></label>
        <label>Vencimento financeiro <input name="payment_due_date" type="date" defaultValue={draft?.finance?.payment_due_date ?? ''}/></label>
      </div>
      {rows.map((row, index) => {
        const product = products.find(item => item.id === row.product)
        const unit = row.line?.item_id === row.product ? row.line.unit : product?.base_unit
        return <fieldset key={row.key}><legend>Item {index + 1}</legend>
          <div className="customer-fields">
            <Combobox label="Produto" required value={row.product} onChange={selected =>
              setRows(current => current.map(entry => entry.key === row.key ? { ...entry, product: selected } : entry))}
              options={[
                ...(!product && row.line && row.product === row.line.item_id
                  ? [{ value: row.product, label: row.line.description + ' (indisponível)', hint: row.line.item_code, disabled: true }] : []),
                ...products.map(item => ({ value: item.id, label: item.original_description, hint: item.original_code + ' · ' + item.base_unit,
                  disabled: rows.some(entry => entry.key !== row.key && entry.product === item.id) })),
              ]}/>
            <label>Quantidade {unit && '(' + unit + ')'} <input name={'quantity-' + row.key}
              defaultValue={row.line?.quantity.replace(/\.0+$/, '')} inputMode="decimal"
              pattern={unit === 'un' ? '[0-9]+' : '[0-9]+([,.][0-9]{1,6})?'} required/></label>
            <label>Preço unitário (R$) <input name={'price-' + row.key} inputMode="decimal"
              defaultValue={row.line?.order_item_financials?.unit_price} pattern="[0-9]+([,.][0-9]{1,2})?" required/></label>
            <label>Desconto da linha (R$) <input name={'discount-' + row.key} inputMode="decimal"
              defaultValue={row.line?.order_item_financials?.discount} pattern="[0-9]+([,.][0-9]{1,2})?"/></label>
          </div>
          {product && unit !== product.base_unit && <>
            <p role="alert">A unidade cadastrada mudou. Informe a quantidade e o preço na nova unidade.</p>
            <button type="button" className="secondary" disabled={busy} onClick={() => setRows(current => current.map(entry =>
              entry.key === row.key ? { key: crypto.randomUUID(), product: row.product, line: undefined } : entry
            ))}>Usar a unidade {product.base_unit}</button>
          </>}
          {rows.length > 1 && <button type="button" className="secondary" disabled={busy}
            onClick={() => setRows(current => current.filter(entry => entry.key !== row.key))}>Remover item {index + 1}</button>}
        </fieldset>
      })}
      <button type="button" className="secondary" disabled={busy || rows.length >= Math.min(100, products.length)}
        onClick={() => setRows(current => [...current, { key: crypto.randomUUID(), product: '', line: undefined }])}>Adicionar item</button>
      <label>Observações operacionais <textarea name="operational_notes" rows={2} maxLength={3000}
        defaultValue={draft?.operational_notes ?? ''}/></label>
      <label>Observações comerciais <textarea name="commercial_notes" rows={2} maxLength={3000}
        defaultValue={draft?.finance?.commercial_notes ?? ''}/></label>
      {error && <p role="alert">{error}</p>}
      <div className="customer-actions">
        <button disabled={busy}>{busy ? 'Salvando…' : 'Salvar rascunho'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>Voltar</button>
      </div>
    </form>}
  </section>
}

function ConfirmDraft({ draft }: { draft: Draft }) {
  const [review, setReview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const requestId = useRef<string | null>(null)
  const inFlight = useRef(false)
  const cache = useQueryClient()

  async function confirm() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    requestId.current ??= crypto.randomUUID()
    try {
      const { error } = await supabase.rpc('confirm_order', {
        target_order: draft.id, expected_version: draft.version, request_id: requestId.current,
      })
      if (error) {
        if (error.code === '40001') await cache.invalidateQueries({ queryKey: ['orders', 'detail', draft.id] })
        throw new Error(error.message)
      }
      await cache.invalidateQueries({ queryKey: ['orders'] })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao confirmar o pedido.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <section>
    {review ? <>
      <p>Confira o prazo e os itens. A confirmação encerra a edição do rascunho e registra a demanda de fabricação própria.</p>
      <div className="customer-actions">
        <button type="button" disabled={busy} onClick={() => void confirm()}>{busy ? 'Confirmando…' : 'Confirmar pedido'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => { setReview(false); setError('') }}>Voltar</button>
      </div>
    </> : <button type="button" disabled={!draft.delivery_date} onClick={() => setReview(true)}>Revisar para confirmar</button>}
    {error && <p role="alert">{error}</p>}
    {!draft.delivery_date && <p>Informe a data de entrega na edição antes de confirmar.</p>}
  </section>
}

export function Orders({ canRegisterBilling, initialOrder, onOpen, startNew = false }: { canRegisterBilling: boolean; initialOrder?: string; onOpen?: (id: string | null) => void; startNew?: boolean }) {
  const [creating, setCreating] = useState(startNew)
  const [configuringDocument, setConfiguringDocument] = useState(false)
  const [editing, setEditing] = useState<Draft | undefined>()
  const selected = initialOrder ?? ''
  const setSelected = (id: string) => onOpen?.(id || null)
  const [filters, setFilters] = useSessionState('orders', emptyFilters)
  const weekPeriod = resolvePeriod('week', todayInSaoPaulo())
  const term = useDebouncedValue(filters.term)
  const today = todayInSaoPaulo()
  const update = (patch: Partial<typeof filters>) => setFilters(current => ({ ...current, page: 0, ...patch }))
  const activeFilters = [filters.term, filters.status, filters.period.from || filters.period.to].filter(Boolean).length
  const orders = useQuery({
    queryKey: ['orders', 'list', term, filters.status, filters.period.from, filters.period.to, filters.sort, filters.page, filters.pageSize, today],
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const column = ['order_number', 'delivery_date', 'customer_name', 'issued_at'].includes(filters.sort?.column ?? '') ? filters.sort!.column : 'order_number'
      const request = supabase.from('orders')
        .select('id,order_number,customer_name,delivery_date,fulfillment_status,issued_at', { count: 'exact' })
        .order(column, { ascending: filters.sort?.direction === 'asc', nullsFirst: false }).order('order_number', { ascending: false })
        .range(filters.page * filters.pageSize, (filters.page + 1) * filters.pageSize - 1).abortSignal(signal)
      const cleaned = term.replace(/[,()*\\%_]/g, ' ').trim()
      const normalized = normalizeText(cleaned)
      if (cleaned) request.or(/^\d+$/.test(cleaned) ? `order_number.eq.${cleaned},search_text.ilike.%${normalized}%` : `search_text.ilike.%${normalized}%`)
      if (filters.status === 'LATE') request.in('fulfillment_status', ['CONFIRMADO', 'PARCIAL']).lt('delivery_date', today)
      else if (filters.status) request.eq('fulfillment_status', filters.status)
      if (filters.period.from) request.gte('delivery_date', filters.period.from)
      if (filters.period.to) request.lte('delivery_date', filters.period.to)
      const { data, count, error } = await request
      if (error) throw error
      return { data: data as ListRow[], count: count ?? 0 }
    },
  })
  const options = useQuery({
    queryKey: ['orders', 'draft-options'],
    enabled: creating || editing !== undefined,
    staleTime: 0,
    queryFn: async () => {
      const [products, customers] = await Promise.all([
        readOptions<Product>((from, to) => supabase.from('items')
          .select('id,original_code,original_description,base_unit').eq('active', true)
          .neq('classification', 'INSUMO').not('base_unit', 'is', null).order('original_code').range(from, to)),
        readOptions<Client>((from, to) => supabase.from('customers').select('id,legal_name,customer_number')
          .eq('active', true).order('legal_name').order('customer_number').range(from, to)),
      ])
      return { products, customers }
    },
  })
  const details = useQuery({
    queryKey: ['orders', 'detail', selected],
    enabled: Boolean(selected),
    queryFn: async () => {
      const { data, error } = await supabase.from('orders')
        .select('id,version,order_number,customer_id,customer_name,fulfillment_status,operational_notes,delivery_date,order_financials(total::text,billed_total::text,billing_status,payment_terms,payment_due_date,commercial_notes),order_items(id,item_id,line_number,item_code,description,quantity::text,unit,confirmed_classification,order_item_financials(unit_price::text,discount::text,total::text))')
        .eq('id', selected).single()
      if (error) throw error
      return { ...data, finance: data.order_financials as unknown as Financial | null, lines: data.order_items as unknown as OrderLine[] }
    },
  })

  const columns: Column<ListRow>[] = [
    { id: 'order_number', header: 'Pedido', width: '7rem', align: 'end', sortValue: row => row.order_number, cell: row => <strong>#{row.order_number}</strong> },
    { id: 'customer_name', header: 'Cliente', sortValue: row => row.customer_name, cell: row => row.customer_name },
    { id: 'issued_at', header: 'Emissão', optional: true, sortValue: row => row.issued_at, cell: row => date(row.issued_at?.slice(0, 10) ?? null) },
    { id: 'delivery_date', header: 'Entrega', sortValue: row => row.delivery_date, cell: row => {
      const state = deadlineState(row, today)
      return <span className="ui-cell-stack">{date(row.delivery_date)}
        {state === 'late' && <Badge tone="danger">Atrasado</Badge>}{state === 'soon' && <Badge tone="warning">Próximo do prazo</Badge>}</span>
    } },
    { id: 'status', header: 'Situação comercial', cell: row => <Badge tone={statusTone[row.fulfillment_status] ?? 'neutral'}>{statuses[row.fulfillment_status] ?? row.fulfillment_status}</Badge> },
  ]

  return <section className={creating || editing || selected || configuringDocument ? 'panel' : undefined}>
    {configuringDocument ? <CommercialDocumentSettings onClose={() => setConfiguringDocument(false)}/> : creating || editing ? <>
      {options.isPending && <p role="status">Carregando clientes e produtos…</p>}
      {options.isError && <p role="alert">Falha ao consultar clientes e produtos. <button onClick={() => {
        setCreating(false)
        setEditing(undefined)
      }}>Voltar</button></p>}
      {options.data && <DraftForm {...options.data} draft={editing} onClose={() => {
        setCreating(false)
        setEditing(undefined)
        if (editing) void details.refetch()
      }} onSaved={id => {
        setCreating(false)
        setEditing(undefined)
        update({})
        setSelected(id)
      }}/>}
    </> : selected ? <>
      <button type="button" className="secondary" onClick={() => setSelected('')}><ArrowLeft aria-hidden="true" size={18}/>Voltar aos pedidos</button>
      {details.isPending && <Skeleton lines={6} label="Carregando pedido…"/>}
      {details.isError && <ErrorState title="Falha ao consultar o pedido" onRetry={() => void details.refetch()}/>}
      {details.data && <section>
        <h2>Pedido {details.data.order_number} · {details.data.customer_name}</h2>
        <p>Status: {statuses[details.data.fulfillment_status] ?? details.data.fulfillment_status}</p>
        {details.data.fulfillment_status === 'RASCUNHO' && <button onClick={() => setEditing(details.data)}>Editar rascunho</button>}
        <p>Entrega {date(details.data.delivery_date)} · Vencimento {date(details.data.finance?.payment_due_date ?? null)}</p>
        {details.data.finance?.payment_terms && <p>Condição de pagamento: {details.data.finance.payment_terms}</p>}
        <div className="table-scroll"><table>
          <thead><tr><th>Item</th><th>Quantidade</th><th>Preço unitário</th><th>Desconto</th><th>Total</th></tr></thead>
          <tbody>{[...details.data.lines].sort((a, b) => a.line_number - b.line_number).map(line => <tr key={line.line_number}>
            <td>{line.item_code} · {line.description}
              {!canRegisterBilling && ['CONFIRMADO', 'PARCIAL'].includes(details.data.fulfillment_status) &&
                line.confirmed_classification &&
                <OrderReservations lineId={line.id} unit={line.unit} deliveryDate={details.data.delivery_date}/>}
            </td><td>{formatStockQuantity(line.quantity)} {line.unit}</td>
            <td>{line.order_item_financials ? currency(line.order_item_financials.unit_price) : '—'}</td>
            <td>{line.order_item_financials ? currency(line.order_item_financials.discount) : '—'}</td>
            <td>{line.order_item_financials ? currency(line.order_item_financials.total) : '—'}</td>
          </tr>)}</tbody>
        </table></div>
        {details.data.finance && <p><strong>Total do pedido {currency(details.data.finance.total)}</strong></p>}
        {details.data.operational_notes && <p>Observações operacionais: {details.data.operational_notes}</p>}
        {details.data.finance?.commercial_notes && <p>Observações comerciais: {details.data.finance.commercial_notes}</p>}
        {details.data.fulfillment_status === 'RASCUNHO' && <ConfirmDraft key={details.data.id + '/' + details.data.version} draft={details.data}/>}
        {details.data.fulfillment_status !== 'RASCUNHO' && details.data.finance && <OrderBilling key={details.data.id}
          orderId={details.data.id} canRegister={canRegisterBilling} total={details.data.finance.total}
          billed={details.data.finance.billed_total} status={details.data.finance.billing_status}/>}
        {canRegisterBilling && details.data.finance?.billing_status === 'FATURADO' &&
          <CommercialDocumentButton key={details.data.id} orderId={details.data.id}/>}
      </section>}
    </> : <>
      <PageHeader icon={ShoppingCart} title="Pedidos" description="Pedidos comerciais, do rascunho à expedição."
        actions={<>
          {!canRegisterBilling && <button className="secondary" type="button" onClick={() => setConfiguringDocument(true)}>
            <FileText aria-hidden="true" size={18}/>Dados do PDF comercial</button>}
          <button type="button" onClick={() => setCreating(true)}><Plus aria-hidden="true" size={18}/>Novo pedido</button>
        </>}/>
      <SavedViews<typeof emptyFilters> scope="orders" current={{ ...filters, page: 0 }} onApply={next => setFilters({ ...next, page: 0 })} presets={[
        { id: 'all', label: 'Todos', filters: emptyFilters },
        { id: 'late', label: 'Atrasados', filters: { ...emptyFilters, status: 'LATE', sort: { column: 'delivery_date', direction: 'asc' } as SortState } },
        { id: 'week', label: 'Entrega nesta semana', filters: { ...emptyFilters, period: { ...weekPeriod, preset: 'week' }, sort: { column: 'delivery_date', direction: 'asc' } as SortState } },
        { id: 'drafts', label: 'Rascunhos', filters: { ...emptyFilters, status: 'RASCUNHO' } },
      ]}/>
      <FilterBar activeCount={activeFilters} onClear={() => setFilters(emptyFilters)} onRefresh={() => void orders.refetch()} refreshing={orders.isFetching}>
        <SearchInput label="Pesquisar por número do pedido ou cliente" value={filters.term} onChange={value => update({ term: value })}/>
        <select aria-label="Situação" value={filters.status} onChange={event => update({ status: event.target.value })}>
          <option value="">Todas as situações</option>
          {Object.entries(statuses).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          <option value="LATE">Atrasados</option>
        </select>
        <PeriodFilter label="Entrega" value={filters.period} onChange={period => update({ period: { from: period.from, to: period.to, preset: period.preset ?? '' } })}/>
      </FilterBar>
      <DataTable caption="Pedidos" rows={orders.data?.data} columns={columns} rowKey={row => row.id}
        loading={orders.isFetching} error={orders.isError} onRetry={() => void orders.refetch()}
        total={orders.data?.count ?? 0} page={filters.page} pageSize={filters.pageSize}
        onPageChange={page => setFilters(current => ({ ...current, page }))} onPageSizeChange={pageSize => update({ pageSize })}
        sort={filters.sort} onSortChange={sort => update({ sort })} preferenceKey="orders"
        filtered={activeFilters > 0} onClearFilters={() => setFilters(emptyFilters)}
        empty={{ title: 'Nenhum pedido lançado', description: 'Crie o primeiro pedido para iniciar o fluxo comercial.' }}
        onRowOpen={row => setSelected(row.id)}
        rowActions={row => <button type="button" className="secondary" onClick={() => setSelected(row.id)}>Abrir<span className="sr-only"> pedido {row.order_number}</span></button>}/>
    </>}
  </section>
}
