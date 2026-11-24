import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { StageResult } from './StageResult'

type Ingredient = {
  source_ingredient_id: string; name: string; quantity: string; unit: string; base_unit: string | null
  lower_tolerance: string; upper_tolerance: string; consumed: string | null
  water_source: string | null; water_reference: string | null
}
type Allocation = {
  lot_id: string; location_id: string; quantity: string; code: string; location: string; expires_on: string | null
}
const format = formatStockQuantity
const isWater = (name: string) => /^(água|agua)$/i.test(name.trim())

function IngredientRow({ batchId, version, ingredient }: { batchId: string; version: number; ingredient: Ingredient }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ amount: string; lots: Allocation[]; version: number } | null>(null)
  const request = useRef<{ fingerprint: string; id: string } | null>(null)
  const inFlight = useRef(false)
  const target = { target_batch: batchId, target_ingredient: ingredient.source_ingredient_id }

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const amount = String(new FormData(event.currentTarget).get('amount')).replace(',', '.')
    inFlight.current = true
    setBusy(true)
    setError('')
    setPreview(null)
    try {
      const { data, error } = await supabase.rpc('preview_preparation_ingredient', { ...target, amount })
      if (error) throw new Error(error.message)
      setPreview({ amount, lots: data as Allocation[], version })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao consultar lotes.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  async function confirm() {
    if (!preview || preview.version !== version || inFlight.current) return
    const params = {
      ...target, expected_version: version, amount: preview.amount, expected_allocations: preview.lots,
    }
    const fingerprint = JSON.stringify(params)
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.rpc('confirm_preparation_ingredient', { ...params, request_id: request.current.id })
      if (error) {
        if (error.code === '40001' || error.code === '23505') {
          setPreview(null)
          await cache.invalidateQueries({ queryKey: ['production-preparation', batchId] })
        }
        throw new Error(error.message)
      }
      setPreview(null)
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['production-preparation', batchId] }),
        cache.invalidateQueries({ queryKey: ['production-board'] }),
        cache.invalidateQueries({ queryKey: ['inventory'] }),
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao confirmar a pesagem.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <article>
    <h4>{ingredient.name}</h4>
    <p>Alvo {format(ingredient.quantity)} {ingredient.unit} · variação −{format(ingredient.lower_tolerance)}
      {' / +'}{format(ingredient.upper_tolerance)} {ingredient.unit}</p>
    {ingredient.consumed !== null ? <p role="status">
      {isWater(ingredient.name) ? 'Água registrada: ' : 'Pesagem confirmada: '}{format(ingredient.consumed)} {ingredient.unit}.
      {ingredient.water_source && ' Origem: ' + ingredient.water_source + ' · Controle: ' + ingredient.water_reference}
    </p>
      : isWater(ingredient.name) ? <WaterForm batchId={batchId} version={version} ingredient={ingredient}/>
      : <>
        <form onSubmit={review} onChange={() => { setPreview(null); setError('') }}>
          <label>Quantidade pesada ({ingredient.unit}) <input name="amount" inputMode="decimal"
            pattern={ingredient.unit === 'un' ? '[0-9]+' : '[0-9]+([,.][0-9]{1,6})?'} required disabled={busy}/></label>
          <button disabled={busy}>Consultar lotes FEFO</button>
        </form>
        {preview && preview.version !== version && <p role="status">A massada mudou. Consulte os lotes novamente.</p>}
        {preview && preview.version === version && <>
          <p>Confira os lotes e as quantidades físicas antes de confirmar a baixa.</p>
          <ul>{preview.lots.map(lot => <li key={lot.lot_id + '/' + lot.location_id}>
            {lot.code} · {lot.location} · {format(lot.quantity)} {ingredient.base_unit}
            {lot.expires_on && ' · validade ' + lot.expires_on.split('-').reverse().join('/')}
          </li>)}</ul>
          <button type="button" disabled={busy} onClick={() => void confirm()}>Confirmar pesagem e baixa</button>
        </>}
      </>}
    {error && <p role="alert">{error}</p>}
  </article>
}

function WaterForm({ batchId, version, ingredient }: { batchId: string; version: number; ingredient: Ingredient }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<{ fingerprint: string; id: string } | null>(null)
  const inFlight = useRef(false)

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const form = new FormData(event.currentTarget)
    const params = {
      target_batch: batchId, target_ingredient: ingredient.source_ingredient_id, expected_version: version,
      amount: String(form.get('amount')).replace(',', '.'), source: form.get('source'), control_reference: form.get('control'),
    }
    const fingerprint = JSON.stringify(params)
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.rpc('record_batch_water', { ...params, request_id: request.current.id })
      if (error) {
        if (error.code === '40001') await cache.invalidateQueries({ queryKey: ['production-preparation', batchId] })
        throw new Error(error.message)
      }
      await cache.invalidateQueries({ queryKey: ['production-preparation', batchId] })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao registrar a água.')
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  return <form onSubmit={save}>
    <label>Quantidade medida ({ingredient.unit}) <input name="amount" inputMode="decimal"
      pattern={ingredient.unit === 'un' ? '[0-9]+' : '[0-9]+([,.][0-9]{1,6})?'} required/></label>
    <label>Origem da água <input name="source" maxLength={300} required/></label>
    <label>Referência do controle da água <input name="control" maxLength={500} required/></label>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy}>{busy ? 'Registrando…' : 'Registrar água medida'}</button>
  </form>
}

type Checklist = {
  version: number; stage: 'PREPARACAO' | 'BATER_MASSA'; prepared_accepted_at: string | null; items: Ingredient[]
  prepared_lots: { name: string; code: string; location: string; quantity: string; unit: string }[]
  prepared_water: { source: string; reference: string; quantity: string; unit: string }[]
}

function StageAction({ batchId, checklist }: { batchId: string; checklist: Checklist }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<{ version: number; id: string } | null>(null)
  const inFlight = useRef(false)
  const preparation = checklist.stage === 'PREPARACAO'

  async function advance() {
    if (inFlight.current) return
    if (request.current?.version !== checklist.version) request.current = { version: checklist.version, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.rpc(preparation ? 'complete_preparation' : 'confirm_prepared_ingredients', {
        target_batch: batchId, expected_version: checklist.version, request_id: request.current.id,
      })
      if (error) {
        if (error.code === '40001') await cache.invalidateQueries({ queryKey: ['production-preparation', batchId] })
        throw new Error(error.message)
      }
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['production-preparation', batchId] }),
        cache.invalidateQueries({ queryKey: ['production-board'] }),
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao atualizar a etapa.')
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  return <div>
    {!preparation && <>
      <h4>Ingredientes separados na preparação</h4>
      {!checklist.prepared_lots.length && !checklist.prepared_water.length && <p>Nenhuma separação registrada na preparação.</p>}
      <ul>{checklist.prepared_lots.map((row, index) => <li key={index}>
        {row.name} · {row.code} · {row.location} · {format(row.quantity)} {row.unit}
      </li>)}{checklist.prepared_water.map((row, index) => <li key={'água-' + index}>
        Água · {row.source} · {format(row.quantity)} {row.unit} · Controle {row.reference}
      </li>)}</ul>
    </>}
    {!preparation && checklist.prepared_accepted_at ? <p role="status">Incorporação confirmada.</p>
      : <button type="button" disabled={busy || (preparation && checklist.items.some(item => item.consumed === null))}
        onClick={() => void advance()}>{busy ? 'Registrando…'
          : preparation ? 'Concluir preparação e iniciar Bater massa' : 'Confirmar incorporação da preparação'}</button>}
    {error && <p role="alert">{error}</p>}
  </div>
}

export function PreparationChecklist({ batchId }: { batchId: string }) {
  const query = useQuery({
    queryKey: ['production-preparation', batchId],
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('production_stage_checklist', { target_batch: batchId })
      if (error) throw error
      return data as Checklist | null
    },
  })

  return <>
    {query.isPending && <p role="status">Carregando ingredientes…</p>}
    {query.isError && <p role="alert">Falha ao consultar os ingredientes da massada.</p>}
    {query.isSuccess && (!query.data || !query.data.items.length) && <p>Nenhum ingrediente adicional nesta etapa.</p>}
    {query.data?.stage === 'BATER_MASSA' && <StageAction batchId={batchId} checklist={query.data}/>}
    {query.data?.items.map(ingredient => <IngredientRow key={ingredient.source_ingredient_id}
      batchId={batchId} version={query.data!.version} ingredient={ingredient}/>)}
    {query.data?.stage === 'PREPARACAO' && <StageAction batchId={batchId} checklist={query.data}/>}
    {query.data?.stage === 'BATER_MASSA' && <StageResult batchId={batchId} version={query.data.version}
      stage="BATER_MASSA" ready={Boolean(query.data.prepared_accepted_at) && query.data.items.every(item => item.consumed !== null)}/>}
  </>
}
