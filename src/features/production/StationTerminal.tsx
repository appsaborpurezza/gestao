import { useEffect, useState } from 'react'
import { CalendarClock, Factory, Timer } from 'lucide-react'
import { Badge, EmptyState, ErrorState, PageHeader, Skeleton } from '../../ui'
import { todayInSaoPaulo } from '../../lib/periods'
import { BatchCard, batchState, columns, stateLabels, type Stage } from './ProductionBoard'
import { batchDeadline, stateTones } from './boardState'
import { formatStageDuration } from './StageTiming'
import { useBoardSnapshot, useStationQueue } from './boardQuery'

const stations = columns.filter(([stage]) => stage !== 'FINALIZADA')
const stationNames: Record<string, string> = {
  PLANEJADA: 'Início de produção', EM_PREPARACAO: 'Preparação', EM_BATER_MASSA: 'Bater massa', EM_CILINDROS: 'Cilindros', EM_EMBALAGEM: 'Embalagem',
}
const storageKey = 'purezza:station'

/**
 * Terminal por estação: o operador escolhe a estação uma vez e vê só a fila dela, com a próxima
 * atividade em destaque e as mesmas ações do Kanban (todas exigem confirmação do servidor).
 */
export function StationTerminal({ canOperate }: { canOperate: boolean }) {
  const [station, setStation] = useState<Stage | null>(() => {
    const saved = localStorage.getItem(storageKey)
    return stations.some(([stage]) => stage === saved) ? saved as Stage : null
  })
  const [selected, setSelected] = useState<string | null>(null)
  // Totais das estações vêm do resumo; a fila da estação escolhida carrega em páginas de 30.
  const { board, realtime } = useBoardSnapshot(1)
  const { query, rows: queue, total } = useStationQueue(station)
  useEffect(() => { if (station) localStorage.setItem(storageKey, station) }, [station])
  const today = board.data?.today ?? todayInSaoPaulo()
  const current = queue.find(batch => batch.id === selected) ?? queue.find(batch => batchState(batch) !== 'blocked')

  return <section className="panel terminal">
    <PageHeader icon={Factory} title={station ? 'Terminal · ' + stationNames[station] : 'Terminal de produção'}
      description={realtime ? 'Atualização em tempo real' : 'Atualização automática a cada minuto'}/>
    <nav className="terminal-stations" aria-label="Estação">
      {stations.map(([stage]) => <button key={stage} type="button" aria-pressed={station === stage}
        onClick={() => { setStation(stage); setSelected(null) }}>
        {stationNames[stage]}
        {board.data && <span className="terminal-count">{board.data.columns[stage].total}</span>}
      </button>)}
    </nav>
    {!station && <EmptyState title="Escolha a estação deste terminal" description="A escolha fica salva neste aparelho e pode ser trocada a qualquer momento."/>}
    {station && query.isPending && <Skeleton lines={5} label="Carregando a fila da estação…"/>}
    {station && query.isError && <ErrorState title="Fila indisponível" description="O terminal tenta de novo automaticamente." onRetry={() => void query.refetch()}/>}
    {station && query.data && (queue.length === 0
      ? <EmptyState title="Nenhuma massada nesta estação" description="Quando uma massada chegar a esta etapa, ela aparece aqui sozinha."/>
      : <div className="terminal-layout">
        <ol className="terminal-queue" aria-label={'Fila de ' + stationNames[station]}>
          {queue.map((batch, index) => {
            const state = batchState(batch)
            const deadline = batchDeadline(batch, today)
            return <li key={batch.id}>
              <button type="button" className="terminal-item" data-state={state} aria-current={current?.id === batch.id || undefined}
                onClick={() => setSelected(batch.id)}>
                <span className="terminal-item-top">
                  <strong>OP {batch.production_number} · {batch.sequence}/{batch.batches_count}</strong>
                  {index === 0 && state !== 'blocked' && <Badge tone="info">Próxima</Badge>}
                  <Badge tone={stateTones[state]}>{stateLabels[state]}</Badge>
                </span>
                <span className="terminal-item-product">{batch.description}</span>
                <span className="terminal-item-meta">
                  <span><CalendarClock aria-hidden="true" size={16}/>{batch.delivery_date.split('-').reverse().join('/')}</span>
                  {deadline === 'late' && <Badge tone="danger">Atrasada</Badge>}
                  {batch.stage_status && <span><Timer aria-hidden="true" size={16}/>{formatStageDuration(batch.stage_net_seconds)}</span>}
                </span>
              </button>
            </li>
          })}
        </ol>
        <div className="terminal-current" aria-live="polite">
          {current ? <BatchCard key={current.id} batch={current} canStart={canOperate}/>
            : <EmptyState title="Todas as massadas desta estação estão bloqueadas" description="Massadas em recolhimento não podem ser operadas."/>}
        </div>
      </div>)}
    {station && total > queue.length && <div className="terminal-more">
      <p className="ui-muted">Exibindo {queue.length} de {total} massadas desta estação.</p>
      <button type="button" className="secondary" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
        {query.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}</button>
    </div>}
  </section>
}
