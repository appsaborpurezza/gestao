import { useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'

export function StageResult({ batchId, version, stage, ready = true }: {
  batchId: string; version: number; stage: 'BATER_MASSA' | 'CILINDROS'; ready?: boolean
}) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const pending = useRef<{ fingerprint: string; id: string } | null>(null)
  const mixing = stage === 'BATER_MASSA'
  const title = mixing ? 'Concluir Bater massa' : 'Concluir Cilindros'
  const next = mixing ? 'Cilindros' : 'Embalagem'

  async function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || inFlight.current) return
    const fields = new FormData(event.currentTarget)
    const params = {
      target_batch: batchId, expected_version: version, current_stage: stage,
      measured_kg: String(fields.get('weight') ?? '').replace(',', '.') || null, notes: fields.get('notes'),
    }
    const fingerprint = JSON.stringify(params)
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.rpc('complete_production_stage', { ...params, request_id: pending.current.id })
      if (error) {
        if (error.code === '40001') await cache.invalidateQueries({ queryKey: ['production-preparation', batchId] })
        throw new Error(error.message)
      }
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['production-preparation', batchId] }),
        cache.invalidateQueries({ queryKey: ['production-board'] }),
        cache.invalidateQueries({ queryKey: ['orders'] }),
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao concluir a etapa.')
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  return <details>
    <summary>{title}</summary>
    <form onSubmit={complete}>
      <label>{mixing ? 'Massa resultante medida (kg)' : 'Massa processada medida (kg)'}
        <input name="weight" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?"/>
      </label>
      <p>Deixe o peso em branco se não foi medido.</p>
      <label>Observações da etapa <textarea name="notes" maxLength={1000} rows={2}/></label>
      {!ready && <p>Confirme a incorporação e conclua todos os apontamentos da etapa.</p>}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy || !ready}>{busy ? 'Registrando…' : 'Concluir e iniciar ' + next}</button>
    </form>
  </details>
}
