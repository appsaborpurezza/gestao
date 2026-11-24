import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'

type Slot = { lot_id: string; location_id: string; code: string; location: string; quantity: string }
type Estimate = { units: string; available_kg: string; nominal_kg: string; actual_kg: string | null; packages: Slot[]; labels: Slot[] }

export function BatchPackaging({ batchId }: { batchId: string }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ input: Record<string, string>; estimate: Estimate } | null>(null)
  const pending = useRef<{ fingerprint: string; id: string } | null>(null)
  const inFlight = useRef(false)
  const locations = useQuery({
    queryKey: ['inventory', 'packaging-locations'],
    queryFn: async () => {
      const { data, error } = await supabase.from('locations').select('id,code').eq('active', true).order('code')
      if (error) throw error
      return data
    },
  })

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const input = Object.fromEntries([...new FormData(event.currentTarget)].map(([name, value]) => [
      name, String(value).replace(',', '.'),
    ]))
    setPreview(null)
    setError('')
    setBusy(true)
    inFlight.current = true
    try {
      const { data, error } = await supabase.rpc('preview_batch_packaging', { target_batch: batchId, input })
      if (error) throw new Error(error.message)
      setPreview({ input, estimate: data as Estimate })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao conferir a embalagem.')
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  async function finish() {
    if (!preview || inFlight.current) return
    const params = { target_batch: batchId, input: preview.input, checked: preview.estimate }
    const fingerprint = JSON.stringify(params)
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.rpc('complete_batch_packaging', { ...params, request_id: pending.current.id })
      if (error) {
        if (error.code === '40001') setPreview(null)
        throw new Error(error.message)
      }
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['production-board'] }),
        cache.invalidateQueries({ queryKey: ['inventory'] }),
        cache.invalidateQueries({ queryKey: ['orders'] }),
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao finalizar embalagem.')
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  return <section>
    {locations.isPending && <p role="status">Carregando locais…</p>}
    {locations.isError && <p role="alert">Falha ao consultar locais ativos.</p>}
    {locations.isSuccess && !locations.data.length && <p>Nenhum local ativo para receber o lote acabado.</p>}
    {!!locations.data?.length && <form onSubmit={check} onChange={() => { setPreview(null); setError('') }}>
      <label>Unidades conformes <input name="units" inputMode="numeric" pattern="[0-9]+" required/></label>
      <label>Massa disponível medida (kg) <input name="available_kg" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?"/></label>
      <p>Se não houver pesagem nova, deixe em branco para usar a última medição registrada.</p>
      <label>Peso real das unidades conformes (kg), se medido <input name="actual_kg" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?"/></label>
      <label>Embalagens rejeitadas <input name="package_rejected" inputMode="numeric" pattern="[0-9]+" required/></label>
      <label>Etiquetas rejeitadas <input name="label_rejected" inputMode="numeric" pattern="[0-9]+" required/></label>
      <p>Informe zero para o material que não teve rejeições.</p>
      <label>Local físico para quarentena <select name="output_location_id" required>
        <option value="">Selecione</option>{locations.data.map(location => <option key={location.id} value={location.id}>{location.code}</option>)}
      </select></label>
      <button disabled={busy}>Conferir embalagem e lotes</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    {preview && <>
      <p>{formatStockQuantity(preview.estimate.units)} unidades · {formatStockQuantity(preview.estimate.nominal_kg)} kg nominais
        {' · '}{formatStockQuantity(preview.estimate.available_kg)} kg disponíveis.</p>
      <p>Confira os lotes físicos antes de confirmar a baixa e a entrada em quarentena.</p>
      {(['packages', 'labels'] as const).map(kind => <section key={kind}>
        <h4>{kind === 'packages' ? 'Embalagens' : 'Etiquetas'}</h4>
        <ul>{preview.estimate[kind].map(slot => <li key={slot.lot_id + '/' + slot.location_id}>
          {slot.code} · {slot.location} · {formatStockQuantity(slot.quantity)} un
        </li>)}</ul>
      </section>)}
      <button type="button" disabled={busy} onClick={() => void finish()}>{busy ? 'Registrando…' : 'Finalizar e receber lote acabado'}</button>
    </>}
  </section>
}
