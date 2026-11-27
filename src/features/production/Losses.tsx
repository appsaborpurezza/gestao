import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Recycle, Scale, Settings2, X } from 'lucide-react'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { Badge, PageHeader, StatCard } from '../../ui'
import { DataTable, type Column } from '../../ui/DataTable'
import { FilterBar } from '../../ui/filters'
import { Tabs } from '../../ui/Tabs'
import { useLossMutation, useLossOptions } from './lossSupport'
import { StockWasteHistory } from '../inventory/StockWaste'
import { CatalogLifecycleDialog, RecordActions, lifecycleActions, useLifecycle } from '../../ui/records'

const operations = {
  PREPARACAO: 'Preparação', BATER_MASSA: 'Bater massa', CILINDROS: 'Cilindros', EMBALAGEM: 'Embalagem', OUTRA: 'Outra operação',
} as const
export type LossOperation = keyof typeof operations
const saoPaulo = 'America/Sao_Paulo'
const dateTime = new Intl.DateTimeFormat('pt-BR', { timeZone: saoPaulo, dateStyle: 'short', timeStyle: 'short' })
const localDay = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: saoPaulo, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())

export function MassLossForm({ batch }: { batch?: { id: string; operation: Exclude<LossOperation, 'OUTRA'> } }) {
  const options = useLossOptions()
  const mutation = useLossMutation('record_mass_loss')
  const versions = useQuery({
    queryKey: ['recipes', 'loss-options'],
    enabled: !batch,
    queryFn: async () => {
      const { data, error } = await supabase.from('recipes').select('name,recipe_versions(id,version)').order('name')
      if (error) throw error
      return data.flatMap(recipe => recipe.recipe_versions.map(version => ({
        id: version.id, label: recipe.name + ' · versão ' + version.version,
      })))
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    void mutation.run({ input: {
      batch_id: batch?.id ?? null, operation: batch?.operation ?? fields.get('operation'),
      recipe_version_id: fields.get('recipe'), quantity_kg: String(fields.get('quantity')).replace(',', '.'),
      reason_id: fields.get('reason'), destination_id: fields.get('destination'),
      occurred_local: fields.get('occurred'), notes: fields.get('notes'),
    } }, form, 'Perda registrada.')
  }

  return <>
    {options.isPending && <p role="status">Carregando motivos e destinações…</p>}
    {options.isError && <p className="ui-message" data-tone="danger" role="alert">Falha ao consultar os cadastros de perdas.</p>}
    {options.data?.destinations.length === 0 && <p className="ui-message">Cadastre uma destinação autorizada para registrar perdas.</p>}
    {!!options.data?.destinations.length && <form className="ui-inline-form" onSubmit={submit}>
      {!batch && <>
        <label>Operação <select name="operation" required><option value="">Selecione</option>
          {Object.entries(operations).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>Receita, se conhecida <select name="recipe"><option value="">Não informada</option>
          {versions.data?.map(version => <option key={version.id} value={version.id}>{version.label}</option>)}
        </select></label>
        {versions.isError && <p className="ui-message" data-tone="danger" role="alert">Falha ao consultar receitas.</p>}
      </>}
      <label>Massa desperdiçada (kg) <input name="quantity" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?" required/></label>
      <label>Motivo <select name="reason" required><option value="">Selecione</option>
        {options.data.reasons.filter(row => row.active).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></label>
      <label>Destinação realizada <select name="destination" required><option value="">Selecione</option>
        {options.data.destinations.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></label>
      {!batch && <label>Data e hora da ocorrência em São Paulo, se diferente da atual
        <input name="occurred" type="datetime-local"/>
      </label>}
      <label>Observações <textarea name="notes" rows={2} maxLength={500}/></label>
      <div><button disabled={mutation.busy}>{mutation.busy ? 'Registrando…' : 'Registrar perda de massa'}</button></div>
    </form>}
    {mutation.feedback && <p className="ui-message" data-tone={mutation.feedback.error ? 'danger' : 'success'} role={mutation.feedback.error ? 'alert' : 'status'}>{mutation.feedback.text}</p>}
  </>
}

function ConfigureLosses({ canAuthorize, onClose }: { canAuthorize: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<'MOTIVO' | 'DESTINACAO'>('MOTIVO')
  const mutation = useLossMutation('add_loss_option')
  return <article className="ui-detail" aria-labelledby="loss-config-title">
    <div className="ui-detail-header">
      <div>
        <h2 id="loss-config-title">Motivos e destinações</h2>
        <p className="ui-muted">Destinações exigem a referência da autorização sanitária.</p>
      </div>
      <button type="button" className="secondary" onClick={onClose}><X aria-hidden="true" size={16}/>Fechar</button>
    </div>
    <form className="ui-inline-form" onSubmit={event => {
      event.preventDefault()
      const form = event.currentTarget
      const fields = new FormData(form)
      void mutation.run({ kind, label: fields.get('label'), reference: fields.get('reference') }, form, 'Cadastro salvo.')
    }}>
      <label>Tipo de cadastro <select value={kind} onChange={event => setKind(event.target.value === 'DESTINACAO' ? 'DESTINACAO' : 'MOTIVO')}>
        <option value="MOTIVO">Motivo</option>{canAuthorize && <option value="DESTINACAO">Destinação autorizada</option>}
      </select></label>
      <label>Nome <input name="label" maxLength={kind === 'MOTIVO' ? 100 : 120} required/></label>
      {kind === 'DESTINACAO' && <label>Referência da autorização sanitária <input name="reference" maxLength={500} required/></label>}
      <div><button disabled={mutation.busy}>Salvar cadastro</button></div>
    </form>
    {mutation.feedback && <p className="ui-message" data-tone={mutation.feedback.error ? 'danger' : 'success'} role={mutation.feedback.error ? 'alert' : 'status'}>{mutation.feedback.text}</p>}
    <LossOptionList kind={kind} canAuthorize={canAuthorize}/>
  </article>
}

type LossOption = { id: string; name: string; active: boolean }

/** Lista de motivos ou destinações com inativação, reativação, exclusão segura e histórico. */
function LossOptionList({ kind, canAuthorize }: { kind: 'MOTIVO' | 'DESTINACAO'; canAuthorize: boolean }) {
  const cache = useQueryClient()
  const lifecycle = useLifecycle()
  const table = kind === 'MOTIVO' ? 'loss_reasons' : 'loss_destinations'
  const list = useQuery({
    queryKey: ['losses', 'option-list', table],
    queryFn: async (): Promise<LossOption[]> => {
      const { data, error } = await supabase.from(table).select('id,name,active').order('active', { ascending: false }).order('name')
      if (error) throw error
      return data
    },
  })
  // Destinações exigem a autorização de liberação de lotes também para inativar ou excluir.
  const manage = kind === 'MOTIVO' || canAuthorize
  const columns: Column<LossOption>[] = [
    { id: 'name', header: kind === 'MOTIVO' ? 'Motivo' : 'Destinação', cell: row => <strong>{row.name}</strong> },
    { id: 'active', header: 'Situação', cell: row => <Badge tone={row.active ? 'success' : 'neutral'}>{row.active ? 'Ativo' : 'Inativo'}</Badge> },
  ]
  return <>
    <DataTable caption={kind === 'MOTIVO' ? 'Motivos cadastrados' : 'Destinações cadastradas'} rows={list.data} columns={columns}
      rowKey={row => row.id} loading={list.isFetching} error={list.isError} onRetry={() => void list.refetch()}
      empty={{ title: 'Nenhum cadastro', description: 'Inclua o primeiro registro no formulário acima.' }}
      rowActions={manage ? row => <RecordActions label={row.name} actions={lifecycleActions(row.active, mode => lifecycle.open(row.id, mode))}/> : undefined}/>
    {manage && <CatalogLifecycleDialog entity={kind === 'MOTIVO' ? 'MOTIVO_PERDA' : 'DESTINACAO_PERDA'}
      recordId={lifecycle.recordId} mode={lifecycle.mode} onClose={lifecycle.close} onModeChange={lifecycle.setMode}
      onDone={() => { lifecycle.close(); void cache.invalidateQueries({ queryKey: ['losses'] }) }}/>}
  </>
}

function ReconcileLoss({ id }: { id: string }) {
  const [finding, setFinding] = useState(false)
  const mutation = useLossMutation('reconcile_mass_loss')
  async function reconcile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (finding || mutation.busy) return
    const form = event.currentTarget
    const fields = new FormData(form)
    setFinding(true)
    mutation.setFeedback(null)
    try {
      const { data, error } = await supabase.from('production_batches').select('id')
        .eq('lot_code', String(fields.get('batch')).trim().toUpperCase()).maybeSingle()
      if (error || !data) throw new Error('Nenhuma massada encontrada para este código.')
      await mutation.run({ target_loss: id, target_batch: data.id, target_stage: fields.get('operation'),
        reason: fields.get('reason') }, form, 'Perda conciliada.')
    } catch (cause) {
      mutation.setFeedback({ text: cause instanceof Error ? cause.message : 'Falha ao localizar a massada.', error: true })
    } finally {
      setFinding(false)
    }
  }

  return <details open><summary>Vincular a uma massada</summary>
    <form className="ui-inline-form" onSubmit={reconcile}>
      <label>Código da massada <input name="batch" placeholder="SP-AAAAMMDD-NNNN" required/></label>
      <label>Etapa <select name="operation" required><option value="">Selecione</option>
        {Object.entries(operations).filter(([key]) => key !== 'OUTRA').map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>Justificativa <input name="reason" maxLength={500} required/></label>
      <div><button disabled={finding || mutation.busy}>Conciliar perda</button></div>
    </form>
    {mutation.feedback && <p className="ui-message" data-tone={mutation.feedback.error ? 'danger' : 'success'} role={mutation.feedback.error ? 'alert' : 'status'}>{mutation.feedback.text}</p>}
  </details>
}

type Report = {
  total: number; total_kg: string; causes: { reason: string; quantity: string }[]
  rows: { id: string; batch_id: string | null; lot_code: string | null; operation: LossOperation; recipe_name: string | null
    quantity: string; reason: string; destination: string; notes: string | null; occurred_at: string; operator: string }[]
}

type LossRow = Report['rows'][number]
type Panel = 'register' | 'config' | null

export function Losses({ admin, canAuthorize, startRegister = false }: { admin: boolean; canAuthorize: boolean; startRegister?: boolean }) {
  const [view, setView] = useState<'mass' | 'stock'>('mass')
  const [panel, setPanel] = useState<Panel>(startRegister ? 'register' : null)
  const today = localDay()
  const initial = { from_day: today, to_day: today, filter_reason: null as string | null }
  const [filter, setFilter] = useState(initial)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [selected, setSelected] = useState<string | null>(null)
  const options = useLossOptions()
  const validPeriod = !!filter.from_day && !!filter.to_day && filter.from_day <= filter.to_day
  const history = useQuery({
    queryKey: ['losses', 'history', filter, page, pageSize],
    enabled: view === 'mass' && validPeriod,
    placeholderData: previous => previous,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('mass_loss_history', { ...filter, page_size: pageSize, page_offset: page * pageSize })
      if (error) throw error
      return data as Report
    },
  })
  const update = (next: Partial<typeof filter>) => { setFilter({ ...filter, ...next }); setPage(0); setSelected(null) }
  const activeFilters = Number(filter.from_day !== today || filter.to_day !== today) + Number(!!filter.filter_reason)
  const togglePanel = (next: Exclude<Panel, null>) => setPanel(panel === next ? null : next)
  const columns: Column<LossRow>[] = [
    { id: 'when', header: 'Ocorrência', cell: row => <span className="ui-cell-stack"><span>{dateTime.format(new Date(row.occurred_at))}</span><span>{row.operator}</span></span> },
    { id: 'quantity', header: 'Massa', align: 'end', cell: row => <strong>{formatStockQuantity(row.quantity)} kg</strong> },
    { id: 'reason', header: 'Motivo', cell: row => row.reason },
    { id: 'operation', header: 'Operação', cell: row => operations[row.operation] },
    { id: 'batch', header: 'Massada e receita', cell: row => <span className="ui-cell-stack">
      {row.lot_code ? <span className="ui-code">{row.lot_code}</span> : <Badge tone="warning">Sem massada</Badge>}
      <span>{row.recipe_name ?? 'Receita não informada'}</span>
    </span> },
    { id: 'destination', header: 'Destinação', optional: true, cell: row => row.destination },
  ]
  const stale = history.isPlaceholderData
  const loss = history.data?.rows.find(row => row.id === selected)
  const topCause = history.data?.causes[0]

  return <section className="panel">
    <PageHeader icon={Recycle} title="Desperdícios"
      description="Perdas de massa na produção e descartes de saldo físico do estoque, com motivo e destinação."
      actions={<>
        {admin && <button type="button" className="secondary" aria-pressed={panel === 'config'} onClick={() => togglePanel('config')}>
          <Settings2 aria-hidden="true" size={16}/>Motivos e destinações</button>}
        {view === 'mass' && <button type="button" aria-pressed={panel === 'register'} onClick={() => togglePanel('register')}>
          <Plus aria-hidden="true" size={16}/>Registrar perda</button>}
      </>}/>
    <Tabs label="Tipos de desperdício" value={view} onChange={next => { setView(next); setPanel(panel === 'register' ? null : panel) }} items={[
      { id: 'mass', label: 'Perdas de massa' }, { id: 'stock', label: 'Descartes de estoque' },
    ]}/>
    {admin && panel === 'config' && <ConfigureLosses canAuthorize={canAuthorize} onClose={() => setPanel(null)}/>}
    {view === 'stock' ? <StockWasteHistory/> : <>
    {panel === 'register' && <article className="ui-detail" aria-labelledby="loss-register-title">
      <div className="ui-detail-header">
        <div>
          <h2 id="loss-register-title">Registrar perda sem massada</h2>
          <p className="ui-muted">Perdas durante uma massada são registradas pelo quadro de produção.</p>
        </div>
        <button type="button" className="secondary" onClick={() => setPanel(null)}><X aria-hidden="true" size={16}/>Fechar</button>
      </div>
      <MassLossForm/>
    </article>}
    <FilterBar activeCount={activeFilters} onClear={() => update(initial)}
      onRefresh={() => void history.refetch()} refreshing={history.isFetching}>
      <label>De <input type="date" value={filter.from_day} max={filter.to_day || today} required
        onChange={event => update({ from_day: event.target.value })}/></label>
      <label>Até <input type="date" value={filter.to_day} min={filter.from_day} max={today} required
        onChange={event => update({ to_day: event.target.value })}/></label>
      <label>Motivo <select value={filter.filter_reason ?? ''} onChange={event => update({ filter_reason: event.target.value || null })}>
        <option value="">Todos</option>
        {options.data?.reasons.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></label>
    </FilterBar>
    {!validPeriod && <p className="ui-message" data-tone="danger" role="alert">Informe um período válido: a data inicial não pode ser posterior à final.</p>}
    {history.data && !stale && <div className="ui-stat-grid">
      <StatCard icon={Scale} label="Massa perdida" value={formatStockQuantity(history.data.total_kg)} unit="kg" tone={Number(history.data.total_kg) > 0 ? 'warning' : 'neutral'}/>
      <StatCard label="Registros no período" value={history.data.total.toLocaleString('pt-BR')}/>
      <StatCard label="Principal causa" value={topCause ? formatStockQuantity(topCause.quantity) : '—'} unit={topCause && 'kg'}
        context={topCause?.reason ?? 'Nenhuma perda no período'}/>
    </div>}
    {history.data && !stale && history.data.causes.length > 1 && <ul className="ui-chip-list" aria-label="Total por causa">
      {history.data.causes.map(cause => <li key={cause.reason}><Badge>{cause.reason} · {formatStockQuantity(cause.quantity)} kg</Badge></li>)}
    </ul>}
    {loss && <article className="ui-detail" aria-labelledby="loss-title">
      <div className="ui-detail-header">
        <div>
          <h2 id="loss-title">{formatStockQuantity(loss.quantity)} kg · {loss.reason}</h2>
          <p className="ui-muted">{dateTime.format(new Date(loss.occurred_at))} · {loss.operator}</p>
        </div>
        <button type="button" className="secondary" onClick={() => setSelected(null)}><X aria-hidden="true" size={16}/>Fechar</button>
      </div>
      <dl>
        <div><dt>Operação</dt><dd>{operations[loss.operation]}</dd></div>
        <div><dt>Massada</dt><dd>{loss.lot_code ? <span className="ui-code">{loss.lot_code}</span> : 'Sem massada identificada'}</dd></div>
        <div><dt>Receita</dt><dd>{loss.recipe_name ?? 'Não informada'}</dd></div>
        <div><dt>Destinação</dt><dd>{loss.destination}</dd></div>
      </dl>
      {loss.notes && <p>{loss.notes}</p>}
      {admin && !loss.batch_id && <ReconcileLoss key={loss.id} id={loss.id}/>}
    </article>}
    <DataTable caption="Histórico de perdas de massa" rows={!validPeriod ? [] : stale ? undefined : history.data?.rows} columns={columns}
      rowKey={row => row.id} loading={history.isFetching} error={history.isError} onRetry={() => void history.refetch()}
      total={validPeriod ? history.data?.total ?? 0 : 0} page={page} pageSize={pageSize} onPageChange={setPage}
      onPageSizeChange={size => { setPageSize(size); setPage(0) }} preferenceKey="mass-losses"
      filtered={activeFilters > 0} onClearFilters={() => update(initial)}
      empty={{ title: 'Nenhuma perda no período', description: 'Altere o período para consultar registros anteriores.' }}
      onRowOpen={row => setSelected(row.id)}
      rowActions={row => <button type="button" className="secondary" onClick={() => setSelected(row.id)}>
        {admin && !row.batch_id ? 'Conciliar' : 'Detalhes'}</button>}/>
    </>}
  </section>
}
