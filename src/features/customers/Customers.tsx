import { useEffect, useRef, useState, type FormEvent } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Pencil, Plus, Save, Users } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { normalizeText } from '../../lib/text'
import { DataTable, type Column, type SortState } from '../../ui/DataTable'
import { FilterBar, SearchInput, useDebouncedValue, useSessionState } from '../../ui/filters'
import { Badge, ErrorState, PageHeader, Skeleton } from '../../ui'
import { CatalogLifecycleDialog, RecordActions, lifecycleActions, useLifecycle } from '../../ui/records'

/** Monta um filtro `or` do PostgREST seguro para texto livre. */
export function customerSearchFilter(term: string) {
  const cleaned = term.replace(/[,()*]/g, ' ').replace(/[\\%_]/g, token => '\\' + token).trim().replace(/\s+/g, ' ')
  if (!cleaned) return null
  const digits = cleaned.replace(/\D/g, '')
  // search_text é gerado no banco sem acento e em minúsculas (migração 20261127000800).
  const parts = [`search_text.ilike.%${normalizeText(cleaned)}%`]
  if (digits.length >= 3) parts.push(`document.ilike.%${digits}%`)
  if (/^\d+$/.test(cleaned)) parts.push(`customer_number.eq.${cleaned}`)
  return parts.join(',')
}

const states = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ')
const identity = [['trade_name', 'Nome fantasia'], ['state_registration', 'Inscrição estadual']] as const
const address = [['postal_code', 'CEP'], ['street', 'Logradouro'], ['address_number', 'Número'], ['complement', 'Complemento'],
  ['district', 'Bairro'], ['city', 'Cidade']] as const
const contact = [['contact_name', 'Pessoa de contato'], ['phone', 'Telefone'], ['whatsapp', 'WhatsApp'], ['email', 'E-mail']] as const
type Row = { id: string; customer_number: number; legal_name: string; trade_name: string | null; document: string | null
  city: string | null; uf: string | null; payment_terms: string | null; active: boolean }

type Existing = { id: string; version: number } & Record<string, string | boolean | number | null>

function CustomerForm({ customer, onClose }: { customer?: Existing; onClose: () => void }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [kind, setKind] = useState(customer?.kind === 'PJ' ? 'PJ' : 'PF')
  const request = useRef<{ fingerprint: string; id: string } | null>(null)
  const inFlight = useRef(false)
  const [dirty, setDirty] = useState(false)
  const value = (key: string) => String(customer?.[key] ?? '')
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  const close = () => {
    if (dirty && !window.confirm('Há alterações não salvas. Deseja descartá-las?')) return
    onClose()
  }
  const input = (name: string, label: string) => <label key={name}>{label}
    <input name={name} defaultValue={value(name)} maxLength={254} type={name === 'email' ? 'email'
      : name === 'phone' || name === 'whatsapp' ? 'tel' : 'text'}
      inputMode={name === 'postal_code' ? 'numeric' : undefined} autoComplete={name === 'email' ? 'email' : 'off'}/>
  </label>

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
      setDirty(false)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao salvar o cliente.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <section className="panel ui-form">
    <header className="ui-form-header">
      <button type="button" className="icon-button" aria-label="Voltar para a lista" onClick={close}><ArrowLeft aria-hidden="true" size={20}/></button>
      <div><h2>{customer ? 'Editar cliente' : 'Novo cliente'}</h2>
        <p>{customer ? `Código ${value('customer_number')} · versão ${customer.version}` : 'Campos com * são obrigatórios.'}</p></div>
    </header>
    <form onSubmit={save} onChange={() => setDirty(true)} aria-busy={busy}>
      <fieldset className="ui-fieldset">
        <legend>Identificação</legend>
        <div className="customer-fields">
          <label>Tipo <span className="ui-required" aria-hidden="true">*</span><select name="kind" value={kind} onChange={event => setKind(event.target.value)}>
            <option value="PF">Pessoa física</option><option value="PJ">Pessoa jurídica</option>
          </select></label>
          <label>{kind === 'PF' ? 'Nome completo' : 'Razão social'} <span className="ui-required" aria-hidden="true">*</span>
            <input name="legal_name" defaultValue={value('legal_name')} required maxLength={180}/>
          </label>
          <label>{kind === 'PF' ? 'CPF' : 'CNPJ'}
            <input name="document" defaultValue={value('document')} maxLength={24} inputMode={kind === 'PF' ? 'numeric' : 'text'}/>
          </label>
          {identity.map(([name, label]) => input(name, label))}
        </div>
      </fieldset>
      <fieldset className="ui-fieldset">
        <legend>Endereço</legend>
        <div className="customer-fields">
          {address.map(([name, label]) => input(name, label))}
          <label>UF <select name="uf" defaultValue={value('uf')}>
            <option value="">Selecione</option>{states.map(state => <option key={state}>{state}</option>)}
          </select></label>
        </div>
      </fieldset>
      <fieldset className="ui-fieldset">
        <legend>Contato</legend>
        <div className="customer-fields">{contact.map(([name, label]) => input(name, label))}</div>
      </fieldset>
      <fieldset className="ui-fieldset">
        <legend>Condições comerciais</legend>
        <div className="customer-fields">
          {input('payment_terms', 'Condição de pagamento')}
          <label>Prazo de pagamento em dias
            <input name="payment_days" type="number" min="0" max="3650" step="1" defaultValue={value('payment_days')}/>
          </label>
        </div>
        <label>Observações <textarea name="notes" maxLength={3000} defaultValue={value('notes')} rows={3}/></label>
        <label className="customer-check"><input name="active" type="checkbox" defaultChecked={customer?.active !== false}/> Cliente ativo</label>
      </fieldset>
      {error && <p role="alert" className="ui-inline-error">{error}</p>}
      <div className="ui-form-actions">
        {dirty && !busy && <span className="ui-form-dirty" role="status">Alterações não salvas</span>}
        <button type="button" className="secondary" disabled={busy} onClick={close}>Cancelar</button>
        <button disabled={busy}><Save aria-hidden="true" size={18}/>{busy ? 'Salvando…' : 'Salvar cliente'}</button>
      </div>
    </form>
  </section>
}

export function Customers({ initialCustomer, onOpen, admin = false, startNew = false }: { initialCustomer?: string; onOpen?: (id: string | null) => void; admin?: boolean; startNew?: boolean }) {
  const lifecycleCache = useQueryClient()
  const lifecycle = useLifecycle()
  const [creating, setCreating] = useState(startNew)
  const editor = creating ? 'new' : initialCustomer ?? null
  const setEditor = (id: string | null) => {
    setCreating(id === 'new')
    if (id !== 'new') onOpen?.(id)
  }
  const [filters, setFilters] = useSessionState('customers', { term: '', status: 'active', uf: '', page: 0, pageSize: 25,
    sort: { column: 'legal_name', direction: 'asc' } as SortState })
  const term = useDebouncedValue(filters.term)
  const activeFilters = [filters.term, filters.status !== 'active' ? filters.status : '', filters.uf].filter(Boolean).length
  const update = (patch: Partial<typeof filters>) => setFilters(current => ({ ...current, page: 0, ...patch }))
  const list = useQuery({
    queryKey: ['customers', 'list', term, filters.status, filters.uf, filters.sort, filters.page, filters.pageSize],
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const sortColumn = filters.sort?.column === 'customer_number' || filters.sort?.column === 'city' ? filters.sort.column : 'legal_name'
      const request = supabase.from('customers')
        .select('id,customer_number,legal_name,trade_name,document,city,uf,payment_terms,active', { count: 'exact' })
        .order(sortColumn, { ascending: filters.sort?.direction !== 'desc' }).order('customer_number')
        .range(filters.page * filters.pageSize, (filters.page + 1) * filters.pageSize - 1).abortSignal(signal)
      const filter = customerSearchFilter(term)
      if (filter) request.or(filter)
      if (filters.status !== 'all') request.eq('active', filters.status === 'active')
      if (filters.uf) request.eq('uf', filters.uf)
      const { data, count, error } = await request
      if (error) throw error
      return { data: data as Row[], count: count ?? 0 }
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

  if (editor === 'new') return <CustomerForm onClose={() => setEditor(null)}/>
  if (editor) {
    if (details.isError) return <ErrorState title="Falha ao consultar o cliente" description="O cliente pode não existir ou não estar disponível para o seu perfil."
      onRetry={() => void details.refetch()}/>
    if (!details.data) return <Skeleton lines={8} label="Carregando cliente…"/>
    return <CustomerForm key={editor + '/' + details.data.version} customer={details.data} onClose={() => setEditor(null)}/>
  }

  const columns: Column<Row>[] = [
    { id: 'customer_number', header: 'Código', width: '6rem', align: 'end', sortValue: row => row.customer_number, cell: row => row.customer_number },
    { id: 'legal_name', header: 'Nome ou razão social', sortValue: row => row.legal_name, cell: row => <div className="ui-cell-stack">
      <strong>{row.legal_name}</strong>{row.trade_name && <small>{row.trade_name}</small>}</div> },
    { id: 'document', header: 'CPF/CNPJ', optional: true, cell: row => row.document ?? '—' },
    { id: 'city', header: 'Cidade', optional: true, sortValue: row => row.city, cell: row => [row.city, row.uf].filter(Boolean).join('/') || '—' },
    { id: 'payment_terms', header: 'Pagamento', optional: true, hiddenByDefault: true, cell: row => row.payment_terms ?? '—' },
    { id: 'active', header: 'Situação', cell: row => <Badge tone={row.active ? 'success' : 'neutral'}>{row.active ? 'Ativo' : 'Inativo'}</Badge> },
  ]

  return <section>
    <PageHeader icon={Users} title="Clientes" description="Cadastro comercial com CPF/CNPJ validado no servidor."
      actions={<button type="button" onClick={() => setEditor('new')}><Plus aria-hidden="true" size={18}/>Novo cliente</button>}/>
    <FilterBar activeCount={activeFilters} onClear={() => update({ term: '', status: 'active', uf: '' })}
      onRefresh={() => void list.refetch()} refreshing={list.isFetching}>
      <SearchInput label="Pesquisar por nome, fantasia, documento, cidade ou código" value={filters.term} onChange={value => update({ term: value })}/>
      <select aria-label="Situação" value={filters.status} onChange={event => update({ status: event.target.value })}>
        <option value="active">Somente ativos</option><option value="inactive">Somente inativos</option><option value="all">Ativos e inativos</option>
      </select>
      <select aria-label="UF" value={filters.uf} onChange={event => update({ uf: event.target.value })}>
        <option value="">Todas as UFs</option>{states.map(state => <option key={state}>{state}</option>)}
      </select>
    </FilterBar>
    <DataTable caption="Clientes" rows={list.data?.data} columns={columns} rowKey={row => row.id}
      loading={list.isFetching} error={list.isError} onRetry={() => void list.refetch()}
      total={list.data?.count ?? 0} page={filters.page} pageSize={filters.pageSize}
      onPageChange={page => setFilters(current => ({ ...current, page }))} onPageSizeChange={pageSize => update({ pageSize })}
      sort={filters.sort} onSortChange={sort => update({ sort })} preferenceKey="customers"
      filtered={activeFilters > 0} onClearFilters={() => update({ term: '', status: 'active', uf: '' })}
      empty={{ title: 'Nenhum cliente cadastrado', description: 'Cadastre o primeiro cliente para lançar pedidos.' }}
      onRowOpen={row => setEditor(row.id)}
      rowActions={row => <RecordActions label={row.legal_name} onEdit={() => setEditor(row.id)}
        actions={admin ? lifecycleActions(row.active, mode => lifecycle.open(row.id, mode)) : []}/>}/>
    {/* Inativação, exclusão segura e histórico de clientes são exclusivos da Administração. */}
    {admin && <CatalogLifecycleDialog entity="CLIENTE" recordId={lifecycle.recordId} mode={lifecycle.mode}
      onClose={lifecycle.close} onModeChange={lifecycle.setMode}
      onDone={() => { lifecycle.close(); void lifecycleCache.invalidateQueries({ queryKey: ['customers'] }) }}/>}
  </section>
}
