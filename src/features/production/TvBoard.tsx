import { useEffect, useRef, useState } from 'react'
import { Maximize, X } from 'lucide-react'
import { todayInSaoPaulo } from '../../lib/periods'
import { batchState, columns } from './ProductionBoard'
import { batchDeadline } from './boardState'
import { formatKg, useBoardSnapshot } from './boardQuery'

const clock = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })
const time = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })

/** Modo TV: leitura à distância, sem ações de escrita e sem valores comerciais nem nomes de clientes. */
export function TvBoard({ onExit }: { onExit: () => void }) {
  const { board, realtime } = useBoardSnapshot(50)
  const [now, setNow] = useState(() => new Date())
  const root = useRef<HTMLDivElement>(null)
  // Relógio local a cada 30 s; não gera consulta ao servidor.
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(timer) }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.fullscreenElement) onExit() }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [onExit])
  const today = board.data?.today ?? todayInSaoPaulo()
  // Totais calculados no servidor sobre o quadro inteiro, não só sobre os cartões carregados.
  const summary = board.data?.summary
  const stages = board.data?.columns

  return <div className="tv" ref={root} role="region" aria-label="Modo TV da produção">
    <header className="tv-header">
      <img src={import.meta.env.BASE_URL + 'logo-128.webp'} alt="Sabor Purezza Massas" width={72} height={72}/>
      <div><h1>Produção</h1><p>{clock.format(now).replace(/^./, letter => letter.toUpperCase())}</p></div>
      <p className="tv-status" data-online={!board.isError}>{board.isError ? 'Sem atualização' : realtime ? 'Tempo real' : 'Atualiza a cada minuto'}
        {board.dataUpdatedAt > 0 && ' · ' + time.format(board.dataUpdatedAt)}</p>
      <div className="tv-controls">
        <button type="button" className="secondary" onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen())}>
          <Maximize aria-hidden="true" size={18}/>Tela cheia</button>
        <button type="button" className="secondary" onClick={onExit}><X aria-hidden="true" size={18}/>Sair</button>
      </div>
    </header>
    {summary && stages ? <>
      <section className="tv-kpis" aria-label="Resumo">
        <div><span>Massadas em produção</span><strong>{summary.active}</strong><small>{formatKg(summary.active_kg)}</small></div>
        <div data-tone="success"><span>Finalizadas hoje</span><strong>{summary.finished_today}</strong><small>{formatKg(summary.finished_today_kg)}</small></div>
        <div data-tone={summary.late ? 'danger' : undefined}><span>Atrasadas</span><strong>{summary.late}</strong></div>
        <div data-tone={summary.paused + summary.blocked ? 'warning' : undefined}><span>Pausadas ou bloqueadas</span><strong>{summary.paused + summary.blocked}</strong></div>
      </section>
      <section className="tv-stages" aria-label="Massadas por etapa">
        {columns.filter(([stage]) => stage !== 'FINALIZADA').map(([stage, title]) => {
          const { total, rows, kg } = stages[stage]
          return <article key={stage}>
            <h2>{title.replace(/ \(.*\)/, '')}</h2>
            <strong className="tv-stage-total">{total}</strong>
            <small className="tv-stage-kg">{formatKg(kg)}</small>
            <ul>{rows.slice(0, 5).map(batch => {
              const state = batchState(batch)
              return <li key={batch.id} data-state={state} data-late={batchDeadline(batch, today) === 'late' || undefined}>
                OP {batch.production_number} · {batch.sequence}/{batch.batches_count}
                {state === 'paused' && ' · Pausada'}{state === 'blocked' && ' · Bloqueada'}
                {batchDeadline(batch, today) === 'late' && ' · Atrasada'}
              </li>
            })}</ul>
            {total > 5 && <small>+{total - 5}</small>}
          </article>
        })}
      </section>
    </> : <p className="tv-loading" role="status">{board.isError ? 'Dados indisponíveis. Nova tentativa automática.' : 'Carregando…'}</p>}
  </div>
}
