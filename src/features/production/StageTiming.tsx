import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'

const timezone = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Sao_Paulo' })
const stamp = (value: string) => timezone.format(new Date(value))

export function formatStageDuration(seconds: number) {
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':')
}

export function StagePauseControl({ batchId, version, paused }: { batchId: string; version: number; paused: boolean }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const pending = useRef<{ payload: string; id: string } | null>(null)

  async function change(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const params = {
      target_batch: batchId, expected_version: version, pause: !paused,
      reason: new FormData(event.currentTarget).get('reason'),
    }
    const payload = JSON.stringify(params)
    if (pending.current?.payload !== payload) pending.current = { payload, id: crypto.randomUUID() }
    setBusy(true)
    setError('')
    inFlight.current = true
    try {
      const { error } = await supabase.rpc('change_production_stage_pause', { ...params, request_id: pending.current.id })
      if (error) {
        if (error.code === '40001') await cache.invalidateQueries({ queryKey: ['production-board'] })
        throw new Error(error.message)
      }
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['production-board'] }),
        cache.invalidateQueries({ queryKey: ['production-stage-times', batchId] }),
        cache.invalidateQueries({ queryKey: ['production-preparation', batchId] }),
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao atualizar a pausa da etapa.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <details>
    <summary>{paused ? 'Retomar etapa' : 'Pausar etapa'}</summary>
    <form onSubmit={change}>
      {!paused && <label>Motivo da pausa <input name="reason" required maxLength={500}/></label>}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy}>{busy ? 'Registrando…' : paused ? 'Confirmar retomada' : 'Confirmar pausa'}</button>
    </form>
  </details>
}

type Timing = {
  stage: string; status: string; net_seconds: number; paused_seconds: number
  started_at: string; finished_at: string | null
  pauses: { id: string; reason: string; paused_at: string; resumed_at: string | null }[]
}

export function StageTiming({ batchId }: { batchId: string }) {
  const [visible, setVisible] = useState(false)
  const query = useQuery({
    queryKey: ['production-stage-times', batchId],
    enabled: visible,
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('production_stage_times', { target_batch: batchId })
      if (error) throw error
      return data as Timing[]
    },
  })

  return <details onToggle={event => setVisible(event.currentTarget.open)}>
    <summary>Histórico de tempos</summary>
    {visible && <>
      {query.isPending && <p role="status">Carregando histórico…</p>}
      {query.isError && <p role="alert">Falha ao consultar o histórico de tempos.</p>}
      {query.data?.map(row => <article key={row.stage}>
        <h4>{row.stage.replaceAll('_', ' ')} · {row.status.replaceAll('_',' ')}</h4>
        <p>Início {stamp(row.started_at)}{row.finished_at && ' · Fim ' + stamp(row.finished_at)}</p>
        <p>Tempo produtivo {formatStageDuration(row.net_seconds)} · Pausas {formatStageDuration(row.paused_seconds)}</p>
        {row.pauses.length > 0 && <ul>{row.pauses.map(pause => <li key={pause.id}>
          {stamp(pause.paused_at)}{pause.resumed_at ? ' até ' + stamp(pause.resumed_at) : ' · Em pausa'} · {pause.reason}
        </li>)}</ul>}
      </article>)}
    </>}
  </details>
}
