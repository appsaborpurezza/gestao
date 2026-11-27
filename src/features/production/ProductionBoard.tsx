import { useEffect, useRef, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { PreparationChecklist } from './PreparationChecklist'
import { StageResult } from './StageResult'
import { BatchPackaging } from './BatchPackaging'
import { formatStageDuration, StagePauseControl, StageTiming } from './StageTiming'
import { MassLossForm, type LossOperation } from './Losses'

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

  return <article className="batch-card">
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

export function ProductionBoard({ canStart }: { canStart: boolean }) {
  const [offsets, setOffsets] = useState<Partial<Record<Stage, number>>>({})
  const [column, setColumn] = useState<Stage>('PLANEJADA')
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
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
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.rpc('production_board_columns', {
        page_size: pageSize, page_offsets: offsets, search,
      }).abortSignal(signal)
      if (error) throw error
      return data as Record<Stage, { total: number; rows: Batch[] }>
    },
  })

  return <section className="panel">
    <h1>Quadro de produção</h1>
    <div className="customer-fields">
      <label>Buscar massadas
        <input type="search" maxLength={100} value={input} onChange={event => setInput(event.target.value)}
          placeholder="OP, pedido, cliente, produto ou lote"/>
      </label>
      <div className="customer-actions">
        <button type="button" className="secondary" disabled={!input && !Object.keys(offsets).length}
          onClick={() => { setInput(''); setSearch(''); setOffsets({}) }}>Limpar filtros</button>
        <button type="button" className="secondary" disabled={board.isFetching}
          onClick={() => void board.refetch()}>Atualizar quadro</button>
      </div>
    </div>
    {board.isPending && <p role="status">Carregando massadas…</p>}
    {board.isError && <p role="alert">Falha ao consultar o quadro de produção. Use Atualizar quadro para tentar novamente.</p>}
    {board.data && <>
      <label className="board-stage-filter">Etapa <select value={column} onChange={event => setColumn(event.target.value as Stage)}>
        {columns.map(([key, title]) => <option key={key} value={key}>{title}</option>)}
      </select></label>
      <div className="production-board" aria-busy={board.isPlaceholderData}>
        {columns.map(([key, title]) => {
          const { total, rows } = board.data[key]
          const offset = offsets[key] ?? 0
          return <section key={key} className="board-stage" data-selected={column === key}>
            <h2>{title} <span className="board-count">{total}</span></h2>
            {rows.length === 0 && <p>{total ? 'Esta página está vazia.' : 'Nenhuma massada nesta etapa.'}</p>}
            {rows.map(batch => <BatchCard key={batch.id} batch={batch} canStart={canStart}/>)}
            {(total > pageSize || offset > 0) && <nav aria-label={`Páginas de ${title}`}>
              <button type="button" className="secondary" disabled={board.isPlaceholderData || offset === 0}
                onClick={() => setOffsets(previous => ({ ...previous, [key]: Math.max(0, offset - pageSize) }))}>Anterior</button>
              <button type="button" className="secondary" disabled={board.isPlaceholderData || offset + pageSize >= total}
                onClick={() => setOffsets(previous => ({ ...previous, [key]: offset + pageSize }))}>Próxima</button>
            </nav>}
          </section>
        })}
      </div>
    </>}
  </section>
}
