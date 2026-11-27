import { useEffect, useRef, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { PreparationChecklist } from './PreparationChecklist'
import { StageResult } from './StageResult'
import { BatchPackaging } from './BatchPackaging'
import { formatStageDuration, StagePauseControl, StageTiming } from './StageTiming'
import { MassLossForm, type LossOperation } from './Losses'
import { useBoardRealtime } from './useBoardRealtime'
import { CalendarClock, Factory, Monitor, PackageCheck, Timer } from 'lucide-react'
import { Badge, ErrorState, PageHeader, Skeleton } from '../../ui'
import { Tabs } from '../../ui/Tabs'
import { FilterBar, SearchInput } from '../../ui/filters'
import { DataTable, type Column } from '../../ui/DataTable'
import { todayInSaoPaulo } from '../../lib/periods'
import { batchDeadline, stateTones } from './boardState'

const columns = [
  ['PLANEJADA', 'Pedidos'],
  ['EM_PREPARACAO', 'Preparação (pesagem dos ingredientes)'],
  ['EM_BATER_MASSA', 'Bater massa'],
  ['EM_CILINDROS', 'Cilindros'],
  ['EM_EMBALAGEM', 'Embalagem'],
  ['FINALIZADA', 'Finalizado'],
] as const
const pageSize = 8
type Stage = typeof columns[number][0]
const lossOperations: Record<string, Exclude<LossOperation, 'OUTRA'>> = {
  EM_PREPARACAO: 'PREPARACAO', EM_BATER_MASSA: 'BATER_MASSA', EM_CILINDROS: 'CILINDROS', EM_EMBALAGEM: 'EMBALAGEM',
}
const dateTime = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short',
})

type Batch = {
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

function BatchCard({ batch, canStart }: { batch: Batch; canStart: boolean }) {
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

function BatchSummary({ batch, today, onOpen, disabled }: { batch: Batch; today: string; onOpen: () => void; disabled?: boolean }) {
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
      {(batch.output_code ?? batch.lot_code) && <span className="ui-code"><PackageCheck aria-hidden="true" size={14}/>{batch.output_code ?? batch.lot_code}</span>}
    </span>
  </button>
}

export function ProductionBoard({ canStart }: { canStart: boolean }) {
  const realtime = useBoardRealtime()
  const [offsets, setOffsets] = useState<Partial<Record<Stage, number>>>({})
  const [column, setColumn] = useState<Stage>('PLANEJADA')
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'board' | 'list'>('board')
  // Densidade dos cartões, lembrada neste navegador: compacto mostra só OP, produto, prazo e situação.
  const [dense, setDense] = useState(() => localStorage.getItem('purezza:board-density') === 'compact')
  useEffect(() => { try { localStorage.setItem('purezza:board-density', dense ? 'compact' : 'detailed') } catch { /* indisponível */ } }, [dense])
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null)
  const details = useRef<HTMLDialogElement>(null)
  const tv = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (input.trim() !== search) {
        setSearch(input.trim())
        setOffsets({})
      }
    }, 300)
    return () => window.clearTimeout(timer)
  }, [input, search])
  const board = useQuery({
    queryKey: ['production-board', 'columns', search, offsets],
    placeholderData: keepPreviousData,
    refetchInterval: realtime ? 300_000 : 60_000,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.rpc('production_board_columns', {
        page_size: pageSize, page_offsets: offsets, search,
      }).abortSignal(signal)
      if (error) throw error
      return data as Record<Stage, { total: number; rows: Batch[] }>
    },
  })
  const pages = board.data
  const selected = pages && selectedBatch
    ? columns.flatMap(([stage]) => pages[stage].rows).find(row => row.id === selectedBatch)
    : undefined

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

  const today = todayInSaoPaulo()
  const openBatch = (id: string) => { setSelectedBatch(id); details.current?.showModal() }
  const currentTitle = columns.find(([key]) => key === column)?.[1] ?? 'etapa'
  const listColumns: Column<Batch>[] = [
    { id: 'op', header: 'OP e massada', cell: batch => <strong>OP {batch.production_number} · {batch.sequence}/{batch.batches_count}</strong> },
    { id: 'order', header: 'Pedido e cliente', cell: batch => <span className="ui-cell-stack"><span>Pedido {batch.order_number}</span><small>{batch.customer_name}</small></span> },
    { id: 'product', header: 'Produto', cell: batch => batch.description },
    { id: 'lot', header: 'Lote', optional: true, cell: batch => <span className="ui-code">{batch.output_code ?? batch.lot_code ?? 'A gerar'}</span> },
    { id: 'delivery', header: 'Entrega', cell: batch => {
      const deadline = batchDeadline(batch, today)
      return <span className="ui-cell-stack"><span>{batch.delivery_date.split('-').reverse().join('/')}</span>
        {deadline === 'late' && <Badge tone="danger">Atrasada</Badge>}{deadline === 'soon' && <Badge tone="warning">Entrega próxima</Badge>}</span>
    } },
    { id: 'state', header: 'Situação', cell: batch => <Badge tone={stateTones[batchState(batch)]}>{stateLabels[batchState(batch)]}</Badge> },
  ]

  return <section className="panel">
    <PageHeader icon={Factory} title="Kanban de produção"
      description={<>{realtime ? 'Atualização em tempo real' : 'Atualização periódica'}
        {board.dataUpdatedAt > 0 && ' · Última consulta ' + dateTime.format(board.dataUpdatedAt)}</>}
      actions={canStart && <button type="button" className="secondary" disabled={!board.data}
        aria-haspopup="dialog" onClick={() => tv.current?.showModal()}><Monitor aria-hidden="true" size={16}/>Gestão à vista</button>}/>
    <Tabs label="Visualização" value={view} onChange={setView} items={[
      { id: 'board', label: 'Quadro por etapa' }, { id: 'list', label: 'Lista da etapa' },
    ]}/>
    <FilterBar activeCount={search ? 1 : 0} onClear={() => { setInput(''); setSearch(''); setOffsets({}) }}
      onRefresh={() => void board.refetch()} refreshing={board.isFetching}>
      <SearchInput label="Buscar por OP, pedido, cliente, produto ou lote" value={input} onChange={setInput}/>
      {view === 'board' && <button type="button" className="secondary" aria-pressed={dense} onClick={() => setDense(value => !value)}>
        {dense ? 'Cartões detalhados' : 'Cartões compactos'}</button>}
      <label className={view === 'board' ? 'board-stage-filter' : undefined}>Etapa <select value={column} onChange={event => setColumn(event.target.value as Stage)}>
        {columns.map(([key, title]) => <option key={key} value={key}>{title}</option>)}
      </select></label>
    </FilterBar>
    {board.isPending && <Skeleton lines={6} label="Carregando massadas…"/>}
    {board.isError && <ErrorState title="Falha ao consultar o quadro de produção" onRetry={() => void board.refetch()}/>}
    {board.data && (view === 'board' ? <div className="kanban" data-density={dense ? 'compact' : undefined} aria-busy={board.isPlaceholderData}>
        {columns.map(([key, title]) => {
          const { total, rows } = board.data[key]
          return <section key={key} className="kanban-column" data-stage={key} data-selected={column === key} aria-labelledby={'stage-' + key}>
            <div className="kanban-column-header">
              <h2 id={'stage-' + key}>{title}</h2>
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
      </div> : <section aria-busy={board.isPlaceholderData}>
        <DataTable caption={currentTitle} rows={board.data[column].rows} columns={listColumns} rowKey={batch => batch.id}
          preferenceKey="production-list" onRowOpen={batch => openBatch(batch.id)}
          filtered={!!search} onClearFilters={() => { setInput(''); setSearch(''); setOffsets({}) }}
          empty={{ title: board.data[column].total ? 'Esta página está vazia' : 'Nenhuma massada nesta etapa' }}
          rowActions={batch => <button type="button" className="secondary" aria-haspopup="dialog" disabled={board.isPlaceholderData}
            onClick={() => openBatch(batch.id)}>Abrir <span className="sr-only">OP {batch.production_number}, massada {batch.sequence}</span></button>}/>
        {pagination(column, currentTitle, board.data[column].total)}
      </section>)}
    <dialog className="board-detail-drawer" ref={details} aria-labelledby="board-detail-title" onClose={() => setSelectedBatch(null)}>
      <div className="ui-detail-header">
        <h2 id="board-detail-title">Detalhes da massada</h2>
        <button type="button" className="secondary" onClick={() => details.current?.close()}>Fechar detalhes</button>
      </div>
      {selected ? <BatchCard key={selected.id} batch={selected} canStart={canStart}/>
        : selectedBatch && <p role="status">A massada saiu da página consultada. Feche os detalhes para voltar ao quadro.</p>}
    </dialog>
    {canStart && <dialog ref={tv} className="board-tv" aria-labelledby="board-tv-title">
      <header>
        <img className="shell-logo" src={import.meta.env.BASE_URL + 'logo-128.webp'} alt="Sabor Purezza Massas" width={56} height={56}/>
        <h2 id="board-tv-title">Gestão à vista · Produção</h2>
        <button type="button" className="secondary" onClick={() => tv.current?.close()}>Fechar gestão à vista</button>
      </header>
      <p role="status">{realtime ? 'Tempo real' : 'Atualização periódica'}
        {board.dataUpdatedAt > 0 && ' · Última consulta ' + dateTime.format(board.dataUpdatedAt)}
        {search && ' · Consulta filtrada'}</p>
      {board.isError && <p role="alert">Dados indisponíveis. O quadro tentará atualizar automaticamente.</p>}
      {board.data && <div className="board-tv-grid">
        {columns.map(([stage, title]) => {
          const { total, rows } = board.data[stage]
          return <section key={stage}>
            <h3>{title}</h3>
            <p><strong>{total}</strong> {total === 1 ? 'massada' : 'massadas'}</p>
            {rows.length > 0 && <ul>{rows.map(batch => <li key={batch.id}>
              OP {batch.production_number} · {batch.sequence}/{batch.batches_count}
              {batch.recalled ? ' · Bloqueada' : batch.stage_status === 'PAUSADA' ? ' · Pausada' : ''}
            </li>)}</ul>}
            {rows.length < total && <small>Exibindo {rows.length} de {total}</small>}
          </section>
        })}
      </div>}
    </dialog>}
  </section>
}
