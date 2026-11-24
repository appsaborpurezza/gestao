import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { formatBrl as currency, formatStockQuantity } from '../../lib/decimal'
import { OrderBilling } from './OrderBilling'
import { CommercialDocumentButton, CommercialDocumentSettings } from './CommercialDocument'
import { OrderReservations } from './OrderReservations'
const date = (value: string | null) => value?.split('-').reverse().join('/') ?? 'A definir'
const pageSize = 20
const statuses: Record<string, string> = { RASCUNHO: 'Rascunho', CONFIRMADO: 'Confirmado', PARCIAL: 'Parcial', EXPEDIDO: 'Expedido' }

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
        <label>Cliente <select name="customer_id" required defaultValue={draft?.customer_id ?? ''}><option value="">Selecione</option>
          {draft && !customers.some(customer => customer.id === draft.customer_id) &&
            <option value={draft.customer_id} disabled>{draft.customer_name} · Inativo</option>}
          {customers.map(customer => <option key={customer.id} value={customer.id}>{customer.customer_number} · {customer.legal_name}</option>)}
        </select></label>
        <label>Previsão de entrega <input name="delivery_date" type="date" defaultValue={draft?.delivery_date ?? ''}/></label>
        <label>Condição de pagamento <input name="payment_terms" maxLength={254} defaultValue={draft?.finance?.payment_terms ?? ''}/></label>
        <label>Vencimento financeiro <input name="payment_due_date" type="date" defaultValue={draft?.finance?.payment_due_date ?? ''}/></label>
      </div>
      {rows.map((row, index) => {
        const product = products.find(item => item.id === row.product)
        const unit = row.line?.item_id === row.product ? row.line.unit : product?.base_unit
        return <fieldset key={row.key}><legend>Item {index + 1}</legend>
          <div className="customer-fields">
            <label>Produto <select value={row.product} onChange={event => {
              const selected = event.target.value
              setRows(current => current.map(entry => entry.key === row.key ? { ...entry, product: selected } : entry))
            }} required>
              <option value="">Selecione</option>
              {!product && row.line && row.product === row.line.item_id && <option value={row.product} disabled>
                {row.line.item_code} · {row.line.description} (indisponível)
              </option>}
              {products.map(item => <option key={item.id} value={item.id}
                disabled={rows.some(entry => entry.key !== row.key && entry.product === item.id)}>
                {item.original_code} · {item.original_description}
              </option>)}
            </select></label>
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

export function Orders({ canRegisterBilling }: { canRegisterBilling: boolean }) {
  const [creating, setCreating] = useState(false)
  const [configuringDocument, setConfiguringDocument] = useState(false)
  const [editing, setEditing] = useState<Draft | undefined>()
  const [selected, setSelected] = useState('')
  const [page, setPage] = useState(0)
  const orders = useQuery({
    queryKey: ['orders', 'list', page],
    queryFn: async () => {
      const { data, count, error } = await supabase.from('orders')
        .select('id,order_number,customer_name,delivery_date,fulfillment_status', { count: 'exact' })
        .order('order_number', { ascending: false }).range(page * pageSize, (page + 1) * pageSize - 1)
      if (error) throw error
      return { data, count: count ?? 0 }
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

  return <section className="panel">
    <h1>Pedidos</h1>
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
        setPage(0)
        setSelected(id)
      }}/>}
    </> : selected ? <>
      <button className="secondary" onClick={() => setSelected('')}>Voltar aos pedidos</button>
      {details.isPending && <p role="status">Carregando pedido…</p>}
      {details.isError && <p role="alert">Falha ao consultar o pedido.</p>}
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
      <button onClick={() => setCreating(true)}>Novo rascunho</button>
      {!canRegisterBilling && <button className="secondary" type="button" onClick={() => setConfiguringDocument(true)}>
        Dados do PDF comercial
      </button>}
      {orders.isPending && <p role="status">Carregando pedidos…</p>}
      {orders.isError && <p role="alert">Falha ao consultar os pedidos.</p>}
      {orders.data?.data.length === 0 && <p>Nenhum pedido cadastrado.</p>}
      {!!orders.data?.data.length && <div className="table-scroll"><table>
        <thead><tr><th>Número</th><th>Cliente</th><th>Entrega</th><th>Status</th><th>Ação</th></tr></thead>
        <tbody>{orders.data.data.map(order => <tr key={order.id}>
          <td>{order.order_number}</td><td>{order.customer_name}</td><td>{date(order.delivery_date)}</td>
          <td>{statuses[order.fulfillment_status] ?? order.fulfillment_status}</td>
          <td><button className="secondary" onClick={() => setSelected(order.id)}>Abrir<span className="sr-only"> pedido {order.order_number}</span></button></td>
        </tr>)}</tbody>
      </table></div>}
      {orders.data && (orders.data.count > pageSize || page > 0) && <nav aria-label="Páginas de pedidos">
        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
        <span>Página {page + 1} · {orders.data.count} pedidos</span>
        <button type="button" disabled={(page + 1) * pageSize >= orders.data.count} onClick={() => setPage(page + 1)}>Próxima</button>
      </nav>}
    </>}
  </section>
}
