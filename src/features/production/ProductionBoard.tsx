import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { PreparationChecklist } from './PreparationChecklist'
import { StageResult } from './StageResult'
import { BatchPackaging } from './BatchPackaging'
import { formatStageDuration, StagePauseControl, StageTiming } from './StageTiming'
import { MassLossForm, type LossOperation } from './Losses'
import { emptyBoardFilters, formatKg, useBoardQuery, type BoardBatch, type BoardFilters, type BoardGroup, type BoardSort, type BoardState } from './boardQuery'
import { CalendarClock, Factory, Monitor, PackageCheck, Timer } from 'lucide-react'
import { Badge, EmptyState, ErrorState, PageHeader, Skeleton } from '../../ui'
import { SavedViews } from '../../ui/SavedViews'
import { Tabs } from '../../ui/Tabs'
import { FilterBar, SearchInput, useDebouncedValue, useSessionState } from '../../ui/filters'
import { DataTable, type Column } from '../../ui/DataTable'
import { todayInSaoPaulo } from '../../lib/periods'
import { batchDeadline, stateTones } from './boardState'

export const columns = [
  ['PLANEJADA', 'Pedidos'],
  ['EM_PREPARACAO', 'Preparação (pesagem dos ingredientes)'],
  ['EM_BATER_MASSA', 'Bater massa'],
  ['EM_CILINDROS', 'Cilindros'],
  ['EM_EMBALAGEM', 'Embalagem'],
  ['FINALIZADA', 'Finalizado'],
] as const
const pageSize = 8
export type Stage = typeof columns[number][0]
const lossOperations: Record<string, Exclude<LossOperation, 'OUTRA'>> = {
  EM_PREPARACAO: 'PREPARACAO', EM_BATER_MASSA: 'BATER_MASSA', EM_CILINDROS: 'CILINDROS', EM_EMBALAGEM: 'EMBALAGEM',
}
const dateTime = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short',
})

export type Batch = {
  id: string; sequence: number; status: string; version: number; lot_code: string | null
  started_at: string | null; stage_started_at: string | null; operator: string | null; production_number: number; batches_count: number
  output_code: string | null
  recalled: boolean
  stage_status: 'EM_EXECUCAO' | 'PAUSADA' | null; stage_net_seconds: number
  order_number: number; customer_name: string; description: string; delivery_date: string
}
export const stateLabels = { blocked: 'Bloqueada', paused: 'Pausada', done: 'Finalizada', running: 'Em execução', waiting: 'Aguardando' }
export function batchState(batch: Pick<Batch, 'recalled' | 'stage_status' | 'status'>) {
  if (batch.recalled) return 'blocked'
  if (batch.stage_status === 'PAUSADA') return 'paused'
  if (batch.status === 'FINALIZADA') return 'done'
  return batch.stage_status === 'EM_EXECUCAO' ? 'running' : 'waiting'
}

export function BatchCard({ batch, canStart }: { batch: Batch; canStart: boolean }) {
  const cache = useQueryClient()
  const [review, setReview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [checklist, setChecklist] = useState(false)
  const [packaging, setPackaging] = useState(false)
  const [lossForm, setLossForm] = useState(false)
  const inFlight = useRef(false)
  const request = useRef<string | null>(null)
  const stageRunning = canStart && !batch.recalled && batch.stage_status === 'EM_EXECUCAO'
  const lossOperation = lossOperations[batch.status]
  const state = batchState(batch)

  async function start() {
    if (inFlight.current) return
    inFlight.current = true
    request.current ??= crypto.randomUUID()
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.rpc('start_batch', {
        target_batch: batch.id, expected_version: batch.version, request_id: request.current,
      })
      if (error) throw new Error(error.message)
      setReview(false)
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['production-board'] }),
        cache.invalidateQueries({ queryKey: ['orders'] }),
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao iniciar a massada.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <article className="batch-card" data-state={state}>
    <span className="batch-status">{stateLabels[state]}</span>
    <h3>OP {batch.production_number} · Massada {batch.sequence}/{batch.batches_count}</h3>
    <p>Pedido {batch.order_number} · {batch.customer_name}</p>
    <p>{batch.description}</p>
    <p>Entrega {batch.delivery_date.split('-').reverse().join('/')}</p>
    {batch.lot_code && <p><strong>{batch.lot_code}</strong></p>}
    {batch.output_code && <p>Lote acabado {batch.output_code}</p>}
    {batch.stage_started_at && <p>Início da etapa {dateTime.format(new Date(batch.stage_started_at))}
      {batch.operator && ' · ' + batch.operator}</p>}
    {batch.stage_status && <p>Tempo produtivo {formatStageDuration(batch.stage_net_seconds)}
      {batch.stage_status === 'PAUSADA' && ' · Etapa pausada'}</p>}
    {batch.recalled && <p role="status">Massada vinculada a recolhimento.</p>}
    {canStart && batch.started_at && <StageTiming batchId={batch.id}/>}
    {canStart && !batch.recalled && batch.stage_status && <StagePauseControl key={batch.stage_status}
      batchId={batch.id} version={batch.version} paused={batch.stage_status === 'PAUSADA'}/>}
    {stageRunning && lossOperation && <details onToggle={event => setLossForm(event.currentTarget.open)}>
      <summary>Apontar perda de massa</summary>
      {lossForm && <MassLossForm batch={{ id: batch.id, operation: lossOperation }}/>}
    </details>}
    {stageRunning && ['EM_PREPARACAO','EM_BATER_MASSA'].includes(batch.status) && <details onToggle={event => setChecklist(event.currentTarget.open)}>
      <summary>{batch.status === 'EM_PREPARACAO' ? 'Apontar preparação' : 'Apontar Bater massa'}</summary>
      {checklist && <PreparationChecklist batchId={batch.id}/>}
    </details>}
    {stageRunning && batch.status === 'EM_CILINDROS' && <StageResult batchId={batch.id} version={batch.version} stage="CILINDROS"/>}
    {stageRunning && batch.status === 'EM_EMBALAGEM' && <details onToggle={event => setPackaging(event.currentTarget.open)}>
      <summary>Apontar embalagem</summary>
      {packaging && <BatchPackaging batchId={batch.id}/>}
    </details>}
    {canStart && batch.status === 'PLANEJADA' && (review ? <>
      <p>Confirme para registrar a preparação e gerar o código de lote.</p>
      <button type="button" disabled={busy} onClick={() => void start()}>{busy ? 'Iniciando…' : 'Confirmar início'}</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => { setReview(false); setError('') }}>Voltar</button>
    </> : <button type="button" onClick={() => setReview(true)}>Iniciar preparação</button>)}
    {error && <p role="alert">{error}</p>}
  </article>
}

function BatchSummary({ batch, today, onOpen, disabled }: { batch: BoardBatch; today: string; onOpen: () => void; disabled?: boolean }) {
  const state = batchState(batch)
  const deadline = batchDeadline(batch, today)
  return <button type="button" className="kanban-card" data-state={state} aria-haspopup="dialog" disabled={disabled} onClick={onOpen}>
    <span className="kanban-card-top">
      <strong>OP {batch.production_number} · {batch.sequence}/{batch.batches_count}</strong>
      <Badge tone={stateTones[state]}>{stateLabels[state]}</Badge>
    </span>
    <span className="kanban-card-product">{batch.description}</span>
    <span className="kanban-card-meta">Pedido {batch.order_number} · {batch.customer_name}</span>
    <span className="kanban-card-foot">
      <span><CalendarClock aria-hidden="true" size={14}/>{batch.delivery_date.split('-').reverse().join('/')}</span>
      {deadline === 'late' && <Badge tone="danger">Atrasada</Badge>}
      {deadline === 'soon' && <Badge tone="warning">Entrega próxima</Badge>}
      {batch.stage_status && <span><Timer aria-hidden="true" size={14}/>{formatStageDuration(batch.stage_net_seconds)}</span>}
      <span className="kanban-card-kg">{formatKg(batch.actual_kg ?? batch.planned_kg)}</span>
      {(batch.output_code ?? batch.lot_code) && <span className="ui-code"><PackageCheck aria-hidden="true" size={14}/>{batch.output_code ?? batch.lot_code}</span>}
    </span>
  </button>
}

const stateFilters: [BoardState, string][] = [['running', 'Em execução'], ['paused', 'Pausadas'], ['waiting', 'Aguardando'], ['blocked', 'Bloqueadas']]
const sortLabels: Record<BoardSort, string> = { delivery: 'Prazo de entrega', op: 'Número da OP', stage_time: 'Mais tempo na etapa', recent: 'Movimentação recente' }
type BoardView = { filters: BoardFilters; sort: BoardSort }
const defaultView: BoardView = { filters: emptyBoardFilters, sort: 'delivery' }

function weekEnd(today: string) {
  const date = new Date(today + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() + 6); return date.toISOString().slice(0, 10)
}

/** Linha por OP: progresso das massadas, distribuição por etapa e kg planejados e produzidos. */
function OrderGroups({ groups, onOpen }: { groups: BoardGroup[]; onOpen: (production: number) => void }) {
  if (!groups.length) return <EmptyState title="Nenhuma OP ativa nestes filtros" description="Limpe os filtros para ver todas as ordens em produção."/>
  return <ul className="board-groups" aria-label="Ordens de produção">
    {groups.map(group => {
      const percent = Math.round(group.done / group.batches_count * 100)
      return <li key={group.production_number}>
        <button type="button" className="board-group" onClick={() => onOpen(group.production_number)}>
          <span className="board-group-top">
            <strong>OP {group.production_number}</strong>
            <span className="board-group-product">{group.description}</span>
            {group.late && <Badge tone="danger">Atrasada</Badge>}
            {group.blocked > 0 && <Badge tone="danger">{group.blocked} bloqueada(s)</Badge>}
            {group.paused > 0 && <Badge tone="neutral">{group.paused} pausada(s)</Badge>}
          </span>
          <span className="ui-muted">Pedido {group.order_number} · {group.customer_name} · Entrega {group.delivery_date.split('-').reverse().join('/')}</span>
          <span className="board-progress" role="progressbar" aria-valuemin={0} aria-valuemax={group.batches_count} aria-valuenow={group.done}
            aria-label={`OP ${group.production_number}: ${group.done} de ${group.batches_count} massadas finalizadas`}>
            <span style={{ width: percent + '%' }}/>
          </span>
          <span className="board-group-foot">
            <span><strong>{group.done}/{group.batches_count}</strong> massadas finalizadas ({percent}%)</span>
            <span>{formatKg(group.produced_kg)} produzidos de {formatKg(group.planned_kg)}</span>
            <span className="board-group-stages">{columns.filter(([stage]) => group.by_stage[stage]).map(([stage, title]) =>
              <span key={stage} className="board-stage-chip" data-stage={stage}>{title.replace(/ \(.*\)/, '')} {group.by_stage[stage]}</span>)}</span>
          </span>
        </button>
      </li>
    })}
  </ul>
}

export function ProductionBoard({ canStart }: { canStart: boolean }) {
  const [offsets, setOffsets] = useState<Partial<Record<Stage, number>>>({})
  const [column, setColumn] = useState<Stage>('PLANEJADA')
  const [stored, setStored] = useSessionState<BoardView>('production-board', defaultView)
  const view = { filters: { ...emptyBoardFilters, ...stored.filters }, sort: stored.sort ?? 'delivery' }
  const [input, setInput] = useState(view.filters.search)
  const [mode, setMode] = useState<'board' | 'groups' | 'list'>('board')
  // Densidade dos cartões, lembrada neste navegador: compacto mostra só OP, produto, prazo e situação.
  const [dense, setDense] = useState(() => localStorage.getItem('purezza:board-density') === 'compact')
  useEffect(() => { try { localStorage.setItem('purezza:board-density', dense ? 'compact' : 'detailed') } catch { /* indisponível */ } }, [dense])
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null)
  const details = useRef<HTMLDialogElement>(null)
  const apply = (next: BoardView) => { setStored(next); setOffsets({}); setInput(next.filters.search) }
  const patch = (filters: Partial<BoardFilters>) => apply({ ...view, filters: { ...view.filters, ...filters } })
  const search = useDebouncedValue(input.trim(), 300)
  useEffect(() => { if (search !== view.filters.search) { setStored(current => ({ ...current, filters: { ...emptyBoardFilters, ...current.filters, search } })); setOffsets({}) } }, [search]) // eslint-disable-line react-hooks/exhaustive-deps
  const { board, realtime } = useBoardQuery(pageSize, offsets, view.filters, view.sort)
  const pages = board.data?.columns
  const summary = board.data?.summary
  const today = board.data?.today ?? todayInSaoPaulo()
  const selected = pages && selectedBatch
    ? columns.flatMap(([stage]) => pages[stage].rows).find(row => row.id === selectedBatch)
    : undefined
  const activeFilters = [view.filters.search, view.filters.states.length, view.filters.deadline, view.filters.delivery_from,
    view.filters.delivery_to, view.filters.production_number].filter(Boolean).length
  const toggleState = (state: BoardState) => patch({ states: view.filters.states.includes(state)
    ? view.filters.states.filter(item => item !== state) : [...view.filters.states, state] })

  function pagination(stage: Stage, title: string, total: number) {
    const offset = offsets[stage] ?? 0
    if (total <= pageSize && offset === 0) return null
    return <nav aria-label={`Páginas de ${title}`}>
      <button type="button" className="secondary" disabled={board.isPlaceholderData || offset === 0}
        onClick={() => setOffsets(previous => ({ ...previous, [stage]: Math.max(0, offset - pageSize) }))}>Anterior</button>
      <span>Página {Math.floor(offset / pageSize) + 1}</span>
      <button type="button" className="secondary" disabled={board.isPlaceholderData || offset + pageSize >= total}
        onClick={() => setOffsets(previous => ({ ...previous, [stage]: offset + pageSize }))}>Próxima</button>
    </nav>
  }

  const openBatch = (id: string) => { setSelectedBatch(id); details.current?.showModal() }
  const currentTitle = columns.find(([key]) => key === column)?.[1] ?? 'etapa'
  const listColumns: Column<BoardBatch>[] = [
    { id: 'op', header: 'OP e massada', cell: batch => <strong>OP {batch.production_number} · {batch.sequence}/{batch.batches_count}</strong> },
    { id: 'order', header: 'Pedido e cliente', cell: batch => <span className="ui-cell-stack"><span>Pedido {batch.order_number}</span><small>{batch.customer_name}</small></span> },
    { id: 'product', header: 'Produto', cell: batch => batch.description },
    { id: 'kg', header: 'Kg', align: 'end', optional: true, cell: batch => formatKg(batch.actual_kg ?? batch.planned_kg) },
    { id: 'lot', header: 'Lote', optional: true, cell: batch => <span className="ui-code">{batch.output_code ?? batch.lot_code ?? 'A gerar'}</span> },
    { id: 'delivery', header: 'Entrega', cell: batch => {
      const deadline = batchDeadline(batch, today)
      return <span className="ui-cell-stack"><span>{batch.delivery_date.split('-').reverse().join('/')}</span>
        {deadline === 'late' && <Badge tone="danger">Atrasada</Badge>}{deadline === 'soon' && <Badge tone="warning">Entrega próxima</Badge>}</span>
    } },
    { id: 'state', header: 'Situação', cell: batch => <Badge tone={stateTones[batchState(batch)]}>{stateLabels[batchState(batch)]}</Badge> },
  ]
  // Indicadores do servidor; cada um aplica o filtro correspondente.
  const kpis: { label: string; value: number; detail?: string; tone?: string; active: boolean; onClick: () => void }[] = summary ? [
    { label: 'Massadas ativas', value: summary.active, detail: formatKg(summary.active_kg), active: activeFilters === 0, onClick: () => apply({ ...view, filters: emptyBoardFilters }) },
    { label: 'Em execução', value: summary.running, tone: 'warning', active: view.filters.states.join() === 'running', onClick: () => patch({ states: ['running'] }) },
    { label: 'Pausadas', value: summary.paused, active: view.filters.states.join() === 'paused', onClick: () => patch({ states: ['paused'] }) },
    { label: 'Bloqueadas', value: summary.blocked, tone: summary.blocked ? 'danger' : undefined, active: view.filters.states.join() === 'blocked', onClick: () => patch({ states: ['blocked'] }) },
    { label: 'Atrasadas', value: summary.late, tone: summary.late ? 'danger' : undefined, active: view.filters.deadline === 'late', onClick: () => patch({ deadline: 'late' }) },
    { label: 'Finalizadas hoje', value: summary.finished_today, detail: formatKg(summary.finished_today_kg), tone: 'success', active: false, onClick: () => { setMode('list'); setColumn('FINALIZADA') } },
  ] : []

  return <section className="panel">
    <PageHeader icon={Factory} title="Kanban de produção"
      description={<>{realtime ? 'Atualização em tempo real' : 'Atualização periódica'}
        {board.dataUpdatedAt > 0 && ' · Última consulta ' + dateTime.format(board.dataUpdatedAt)}</>}
      actions={canStart && <button type="button" className="secondary" onClick={() => { location.hash = '#/tv' }}><Monitor aria-hidden="true" size={16}/>Modo TV</button>}/>
    {summary && <div className="board-kpis" role="group" aria-label="Indicadores do quadro (filtros atuais)">
      {kpis.map(kpi => <button key={kpi.label} type="button" className="board-kpi" data-tone={kpi.tone} aria-pressed={kpi.active} onClick={kpi.onClick}>
        <span>{kpi.label}</span><strong>{kpi.value.toLocaleString('pt-BR')}</strong>{kpi.detail && <small>{kpi.detail}</small>}
      </button>)}
    </div>}
    <SavedViews<BoardView> scope="production-board" current={view} onApply={apply} presets={[
      { id: 'all', label: 'Todas', filters: defaultView },
      { id: 'late', label: 'Atrasadas', filters: { ...defaultView, filters: { ...emptyBoardFilters, deadline: 'late' } } },
      { id: 'week', label: 'Entrega nesta semana', filters: { ...defaultView, filters: { ...emptyBoardFilters, deadline: 'week' } } },
      { id: 'attention', label: 'Pausadas e bloqueadas', filters: { ...defaultView, filters: { ...emptyBoardFilters, states: ['paused', 'blocked'] } } },
      { id: 'slow', label: 'Mais tempo na etapa', filters: { filters: { ...emptyBoardFilters, states: ['running'] }, sort: 'stage_time' } },
    ]}/>
    <Tabs label="Visualização" value={mode} onChange={setMode} items={[
      { id: 'board', label: 'Quadro por etapa' }, { id: 'groups', label: 'Por OP' }, { id: 'list', label: 'Lista da etapa' },
    ]}/>
    <FilterBar activeCount={activeFilters} onClear={() => apply({ ...view, filters: emptyBoardFilters })}
      onRefresh={() => void board.refetch()} refreshing={board.isFetching}>
      <SearchInput label="Buscar por OP, pedido, cliente, produto ou lote" value={input} onChange={setInput}/>
      <div className="board-state-filter" role="group" aria-label="Situação">
        {stateFilters.map(([state, label]) => <button key={state} type="button" className="ui-view-chip-button" aria-pressed={view.filters.states.includes(state)}
          onClick={() => toggleState(state)}>{label}</button>)}
      </div>
      <label>Prazo <select value={view.filters.deadline} onChange={event => patch({ deadline: event.target.value as BoardFilters['deadline'] })}>
        <option value="">Todos</option><option value="late">Atrasadas</option><option value="soon">Atrasadas ou em até 2 dias</option>
        <option value="today">Entrega hoje</option><option value="week">Entrega nos próximos 7 dias</option>
      </select></label>
      <label>Entrega de <input type="date" value={view.filters.delivery_from} onChange={event => patch({ delivery_from: event.target.value })}/></label>
      <label>até <input type="date" value={view.filters.delivery_to} min={view.filters.delivery_from || undefined} onChange={event => patch({ delivery_to: event.target.value })}/></label>
      <label>Ordenar por <select value={view.sort} onChange={event => apply({ ...view, sort: event.target.value as BoardSort })}>
        {(Object.keys(sortLabels) as BoardSort[]).map(key => <option key={key} value={key}>{sortLabels[key]}</option>)}
      </select></label>
      {view.filters.production_number && <button type="button" className="ui-view-chip-button" aria-pressed="true"
        onClick={() => patch({ production_number: '' })}>OP {view.filters.production_number} ×</button>}
      {mode === 'board' && <button type="button" className="secondary" aria-pressed={dense} onClick={() => setDense(value => !value)}>
        {dense ? 'Cartões detalhados' : 'Cartões compactos'}</button>}
      {mode !== 'groups' && <label className={mode === 'board' ? 'board-stage-filter' : undefined}>Etapa <select value={column} onChange={event => setColumn(event.target.value as Stage)}>
        {columns.map(([key, title]) => <option key={key} value={key}>{title}</option>)}
      </select></label>}
    </FilterBar>
    {board.isPending && <Skeleton lines={6} label="Carregando massadas…"/>}
    {board.isError && <ErrorState title="Falha ao consultar o quadro de produção" onRetry={() => void board.refetch()}/>}
    {pages && (mode === 'board' ? <div className="kanban" data-density={dense ? 'compact' : undefined} aria-busy={board.isPlaceholderData}>
        {columns.map(([key, title]) => {
          const { total, rows, kg } = pages[key]
          return <section key={key} className="kanban-column" data-stage={key} data-selected={column === key} aria-labelledby={'stage-' + key}>
            <div className="kanban-column-header">
              <h2 id={'stage-' + key}>{title}<small className="kanban-kg">{formatKg(kg)}</small></h2>
              <span className="kanban-count" aria-label={`${total} ${total === 1 ? 'massada' : 'massadas'}`}>{total}</span>
            </div>
            <div className="kanban-column-body">
              {rows.length === 0 && <p className="kanban-empty">{total ? 'Esta página está vazia.' : 'Nenhuma massada nesta etapa.'}</p>}
              {rows.map(batch => <BatchSummary key={batch.id} batch={batch} today={today}
                disabled={board.isPlaceholderData} onOpen={() => openBatch(batch.id)}/>)}
            </div>
            {pagination(key, title, total)}
          </section>
        })}
      </div> : mode === 'groups' ? <section aria-busy={board.isPlaceholderData}>
        <OrderGroups groups={board.data?.groups ?? []} onOpen={production => { patch({ production_number: String(production) }); setMode('board') }}/>
        {board.data?.groups.length === 100 && <p className="ui-muted">Exibindo as 100 OPs com entrega mais próxima. Refine os filtros para ver outras.</p>}
      </section> : <section aria-busy={board.isPlaceholderData}>
        <DataTable caption={currentTitle} rows={pages[column].rows} columns={listColumns} rowKey={batch => batch.id}
          preferenceKey="production-list" onRowOpen={batch => openBatch(batch.id)}
          filtered={activeFilters > 0} onClearFilters={() => apply({ ...view, filters: emptyBoardFilters })}
          empty={{ title: pages[column].total ? 'Esta página está vazia' : 'Nenhuma massada nesta etapa' }}
          rowActions={batch => <button type="button" className="secondary" aria-haspopup="dialog" disabled={board.isPlaceholderData}
            onClick={() => openBatch(batch.id)}>Abrir <span className="sr-only">OP {batch.production_number}, massada {batch.sequence}</span></button>}/>
        {pagination(column, currentTitle, pages[column].total)}
      </section>)}
    <dialog className="board-detail-drawer" ref={details} aria-labelledby="board-detail-title" onClose={() => setSelectedBatch(null)}>
      <div className="ui-detail-header">
        <h2 id="board-detail-title">Detalhes da massada</h2>
        <button type="button" className="secondary" onClick={() => details.current?.close()}>Fechar detalhes</button>
      </div>
      {selected ? <BatchCard key={selected.id} batch={selected} canStart={canStart}/>
        : selectedBatch && <p role="status">A massada saiu da página consultada. Feche os detalhes para voltar ao quadro.</p>}
    </dialog>
  </section>
}
