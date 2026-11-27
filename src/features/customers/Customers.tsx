import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'

const states = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ')
const fields = [
  ['trade_name', 'Nome fantasia'], ['state_registration', 'Inscrição estadual'], ['street', 'Logradouro'],
  ['address_number', 'Número'], ['complement', 'Complemento'], ['district', 'Bairro'], ['city', 'Cidade'],
  ['postal_code', 'CEP'], ['phone', 'Telefone'], ['whatsapp', 'WhatsApp'], ['email', 'E-mail'],
  ['contact_name', 'Pessoa de contato'], ['payment_terms', 'Condição de pagamento'],
] as const
const pageSize = 25

type Existing = { id: string; version: number } & Record<string, string | boolean | number | null>

function CustomerForm({ customer, onClose }: { customer?: Existing; onClose: () => void }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [kind, setKind] = useState(customer?.kind === 'PJ' ? 'PJ' : 'PF')
  const request = useRef<{ fingerprint: string; id: string } | null>(null)
  const inFlight = useRef(false)
  const value = (key: string) => String(customer?.[key] ?? '')

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const form = new FormData(event.currentTarget)
    const input = { ...Object.fromEntries(form), active: form.has('active') }
    const fingerprint = JSON.stringify(input)
    if (request.current?.fingerprint !== fingerprint) {
      request.current = { fingerprint, id: crypto.randomUUID() }
    }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.rpc('save_customer', {
        target_customer: customer?.id ?? null, expected_version: customer?.version ?? null,
        input, request_id: request.current.id,
      })
      if (error) {
        const messages: Record<string, string> = {
          '23505': 'Já existe um cliente com este documento.',
          '23514': 'Confira o CEP, o e-mail e o prazo de pagamento.',
          '40001': 'O cadastro mudou. Feche e reabra o cliente para editar a versão atual.',
        }
        throw new Error(messages[error.code] ?? error.message)
      }
      await cache.invalidateQueries({ queryKey: ['customers'] })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao salvar o cliente.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <section>
    <h2>{customer ? 'Editar cliente' : 'Novo cliente'}</h2>
    <form onSubmit={save}>
      <div className="customer-fields">
        <label>Tipo <select name="kind" value={kind} onChange={event => setKind(event.target.value)}>
          <option value="PF">Pessoa física</option><option value="PJ">Pessoa jurídica</option>
        </select></label>
        <label>{kind === 'PF' ? 'Nome completo' : 'Razão social'}
          <input name="legal_name" defaultValue={value('legal_name')} required maxLength={180}/>
        </label>
        <label>{kind === 'PF' ? 'CPF' : 'CNPJ'}
          <input name="document" defaultValue={value('document')} maxLength={24} inputMode={kind === 'PF' ? 'numeric' : 'text'}/>
        </label>
        {fields.map(([name, label]) => <label key={name}>{label}
          <input name={name} defaultValue={value(name)} maxLength={254} type={name === 'email' ? 'email'
            : name === 'phone' || name === 'whatsapp' ? 'tel' : 'text'}/>
        </label>)}
        <label>UF <select name="uf" defaultValue={value('uf')}>
          <option value="">Selecione</option>{states.map(state => <option key={state}>{state}</option>)}
        </select></label>
        <label>Prazo de pagamento em dias
          <input name="payment_days" type="number" min="0" max="3650" step="1" defaultValue={value('payment_days')}/>
        </label>
      </div>
      <label>Observações <textarea name="notes" maxLength={3000} defaultValue={value('notes')} rows={3}/></label>
      <label className="customer-check"><input name="active" type="checkbox" defaultChecked={customer?.active !== false}/> Cliente ativo</label>
      {error && <p role="alert">{error}</p>}
      <div className="customer-actions">
        <button disabled={busy}>{busy ? 'Salvando…' : 'Salvar cliente'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>Voltar</button>
      </div>
    </form>
  </section>
}

export function Customers({ initialCustomer }: { initialCustomer?: string }) {
  const [editor, setEditor] = useState<string | null>(initialCustomer ?? null)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const list = useQuery({
    queryKey: ['customers', 'list', search, page],
    queryFn: async () => {
      const request = supabase.from('customers').select('id,customer_number,legal_name,trade_name,city,uf,active', { count: 'exact' })
        .order('legal_name').order('customer_number').range(page * pageSize, (page + 1) * pageSize - 1)
      if (search) request.ilike('legal_name', '%' + search.replace(/[\\%_]/g, token => '\\' + token) + '%')
      const { data, count, error } = await request
      if (error) throw error
      return { data, count: count ?? 0 }
    },
  })
  const details = useQuery({
    queryKey: ['customers', 'customer', editor],
    enabled: editor !== null && editor !== 'new',
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      const { data, error } = await supabase.from('customers').select('*').eq('id', editor!).single()
      if (error) throw error
      return data as Existing
    },
  })

  return <section className="panel">
    <h1>Clientes</h1>
    {editor !== null ? <>
      {editor === 'new' && <CustomerForm onClose={() => setEditor(null)}/>}
      {editor !== 'new' && details.isFetching && !details.data && <p role="status">Carregando cliente…</p>}
      {editor !== 'new' && details.isError && <p role="alert">Falha ao consultar o cliente. <button onClick={() => setEditor(null)}>Voltar</button></p>}
      {editor !== 'new' && details.data && <CustomerForm key={editor + '/' + details.data.version}
        customer={details.data} onClose={() => setEditor(null)}/>}
    </> : <>
      <button onClick={() => setEditor('new')}>Novo cliente</button>
      <form onSubmit={event => {
        event.preventDefault()
        setPage(0)
        setSearch(String(new FormData(event.currentTarget).get('search') ?? '').trim())
      }}>
        <label>Buscar por nome ou razão social <input name="search" type="search" defaultValue={search} maxLength={180}/></label>
        <button>Buscar</button>
      </form>
      {list.isPending && <p role="status">Carregando clientes…</p>}
      {list.isError && <p role="alert">Falha ao consultar clientes.</p>}
      {list.data?.data.length === 0 && <p>Nenhum cliente encontrado.</p>}
      {!!list.data?.data.length && <div className="table-scroll"><table>
        <thead><tr><th>Código</th><th>Nome ou razão social</th><th>Cidade</th><th>Status</th><th>Ação</th></tr></thead>
        <tbody>{list.data.data.map(customer => <tr key={customer.id}>
          <td>{customer.customer_number}</td>
          <td>{customer.legal_name}{customer.trade_name && <div>{customer.trade_name}</div>}</td>
          <td>{[customer.city, customer.uf].filter(Boolean).join('/')}</td>
          <td>{customer.active ? 'Ativo' : 'Inativo'}</td>
          <td><button className="secondary" onClick={() => setEditor(customer.id)}>Editar<span className="sr-only"> {customer.legal_name}</span></button></td>
        </tr>)}</tbody>
      </table></div>}
      {list.data && (list.data.count > pageSize || page > 0) && <nav aria-label="Páginas de clientes">
        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
        <span>Página {page + 1} · {list.data.count} clientes</span>
        <button type="button" disabled={(page + 1) * pageSize >= list.data.count} onClick={() => setPage(page + 1)}>Próxima</button>
      </nav>}
    </>}
  </section>
}
