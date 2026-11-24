import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatBrl, subtractAmount } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'

type Props = { orderId: string; canRegister: boolean; total: string; billed: string; status: string }
const dates = (value: string) => value.split('-').reverse().join('/')
const statuses: Record<string, string> = { NAO_FATURADO: 'Não faturado', PARCIAL: 'Parcial', FATURADO: 'Faturado' }
const pageSize = 10

function BillingForm({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const cache = useQueryClient()
  const [installments, setInstallments] = useState([crypto.randomUUID()])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const pending = useRef<{ payload: string; id: string } | null>(null)

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const form = new FormData(event.currentTarget)
    const decimal = (name: string) => String(form.get(name) ?? '').replace(',', '.')
    const input = {
      invoice_number: form.get('number'),
      invoice_series: form.get('series'),
      invoice_access_key: form.get('key'),
      issued_on: form.get('issued_on'),
      amount: decimal('amount'),
      installments: installments.map(id => ({ due_on: form.get('due-' + id), amount: decimal('amount-' + id) })),
    }
    const payload = JSON.stringify(input)
    if (pending.current?.payload !== payload) pending.current = { payload, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.rpc('register_billing', { target_order: orderId, input, request_id: pending.current.id })
      if (error) {
        const messages: Record<string, string> = {
          '23505': 'Esta nota já está registrada neste pedido.',
          '23514': 'Confira o número, a série e a chave da nota.',
          '22003': 'Confira os valores do faturamento.',
        }
        throw new Error(messages[error.code] ?? error.message)
      }
      await cache.invalidateQueries({ queryKey: ['orders'] })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao registrar faturamento.')
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  return <form onSubmit={save}>
    <div className="customer-fields">
      <label>Número da nota externa <input name="number" maxLength={30} required/></label>
      <label>Série <input name="series" maxLength={12}/></label>
      <label>Chave de acesso da NF-e, se houver <input name="key" inputMode="numeric" pattern="[0-9]{44}" maxLength={44}/></label>
      <label>Data de emissão <input name="issued_on" type="date" required/></label>
      <label>Valor faturado neste pedido (R$) <input name="amount" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,2})?" required/></label>
    </div>
    {installments.map((id, index) => <fieldset key={id}><legend>Parcela {index + 1}</legend>
      <div className="customer-fields">
        <label>Vencimento <input name={'due-' + id} type="date" required/></label>
        <label>Valor (R$) <input name={'amount-' + id} inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,2})?" required/></label>
      </div>
      {installments.length > 1 && <button type="button" className="secondary" disabled={busy}
        onClick={() => setInstallments(current => current.filter(entry => entry !== id))}>Remover parcela {index + 1}</button>}
    </fieldset>)}
    <button type="button" className="secondary" disabled={busy || installments.length >= 60}
      onClick={() => setInstallments(current => [...current, crypto.randomUUID()])}>Adicionar parcela</button>
    {error && <p role="alert">{error}</p>}
    <div className="customer-actions">
      <button disabled={busy}>{busy ? 'Registrando…' : 'Salvar faturamento'}</button>
      <button type="button" className="secondary" onClick={onClose} disabled={busy}>Voltar</button>
    </div>
  </form>
}

export function OrderBilling({ orderId, canRegister, total, billed, status }: Props) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)
  const records = useQuery({
    queryKey: ['orders', 'billing', orderId, page],
    queryFn: async () => {
      const { data, count, error } = await supabase.from('billing_records')
        .select('id,invoice_number,invoice_series,invoice_access_key,issued_on,amount::text,billing_installments(position,due_on,amount::text)', { count: 'exact' })
        .eq('order_id', orderId).order('issued_on', { ascending: false }).order('id')
        .range(page * pageSize, (page + 1) * pageSize - 1)
      if (error) throw error
      return { data, count: count ?? 0 }
    },
  })
  const remaining = subtractAmount(total, billed)
  return <section>
    <h3>Faturamento externo</h3>
    <p>{statuses[status] ?? status} · Faturado {formatBrl(billed)} · Saldo a faturar {formatBrl(remaining)}</p>
    {open ? <BillingForm orderId={orderId} onClose={() => { setOpen(false); setPage(0) }}/>
      : canRegister && remaining !== '0.00' && <button type="button" onClick={() => setOpen(true)}>Registrar faturamento</button>}
    {records.isPending && <p role="status">Carregando notas registradas…</p>}
    {records.isError && <p role="alert">Falha ao consultar o faturamento.</p>}
    {records.data?.data.length === 0 && <p>Nenhuma nota registrada.</p>}
    {records.data?.data.map(record => <article key={record.id}>
      <h4>Nota {record.invoice_number}{record.invoice_series && ' · Série ' + record.invoice_series}</h4>
      <p>Emissão {dates(record.issued_on)} · {formatBrl(record.amount)}</p>
      {record.invoice_access_key && <p>Chave de acesso <span className="break-code">{record.invoice_access_key}</span></p>}
      <ul>{[...record.billing_installments].sort((a, b) => a.position - b.position).map(installment => <li key={installment.position}>
        Parcela {installment.position} · {dates(installment.due_on)} · {formatBrl(installment.amount)}
      </li>)}</ul>
    </article>)}
    {records.data && (records.data.count > pageSize || page > 0) && <nav aria-label="Páginas de faturamento">
      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
      <span>Página {page + 1} · {records.data.count} notas</span>
      <button type="button" disabled={(page + 1) * pageSize >= records.data.count} onClick={() => setPage(page + 1)}>Próxima</button>
    </nav>}
  </section>
}
