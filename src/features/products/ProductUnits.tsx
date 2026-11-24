import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { PackagingConfig } from './PackagingConfig'

type Product = { id: string; original_code: string; original_description: string; base_unit: string | null; unit_version: number; classification: string }
const units = ['kg', 'g', 'un', 'L', 'mL']

export function ProductUnits({ product, onClose }: { product: Product; onClose: () => void }) {
  const cache = useQueryClient()
  const [unit, setUnit] = useState(product.base_unit ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const pending = useRef<{ payload: string; id: string } | null>(null)
  const current = useQuery({
    queryKey: ['items', 'weight-conversion', product.id, product.unit_version],
    queryFn: async () => {
      const { data, error } = await supabase.from('item_unit_conversions')
        .select('kg_per_unit::text').eq('item_id', product.id).eq('version', product.unit_version).maybeSingle()
      if (error) throw error
      return data?.kg_per_unit ?? ''
    },
  })
  const fixed = unit === 'kg' || unit === 'g'

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const fields = new FormData(event.currentTarget)
    const params = {
      target_item: product.id,
      expected_version: product.unit_version,
      base_unit: unit,
      factor: String(fields.get('factor') ?? '').replace(',', '.') || null,
      reason: fields.get('reason'),
    }
    const payload = JSON.stringify(params)
    if (pending.current?.payload !== payload) pending.current = { payload, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.rpc('configure_item_units', { ...params, request_id: pending.current.id })
      if (error) throw new Error(error.message)
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['items'] }),
        cache.invalidateQueries({ queryKey: ['inventory'] }),
        cache.invalidateQueries({ queryKey: ['orders'] }),
      ])
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao salvar a configuração.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <section>
    <h2>Unidade e conversão para kg</h2>
    <p>{product.original_code} · {product.original_description}</p>
    {current.isPending && <p role="status">Carregando configuração…</p>}
    {current.isError && <p role="alert">Falha ao consultar a configuração atual.</p>}
    {current.isSuccess && <form onSubmit={save}>
      <label>Unidade base <select name="unit" value={unit} required onChange={event => setUnit(event.target.value)}>
        <option value="">Selecione</option>{units.map(value => <option key={value}>{value}</option>)}
      </select></label>
      {fixed && <p>Conversão fixa de massa: {unit === 'kg' ? '1' : '0,001'} kg por {unit}.</p>}
      {unit && !fixed && <label>Kg por {unit} (opcional)
        <input key={unit} name="factor" defaultValue={unit === product.base_unit ? current.data : ''}
          inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?"/>
      </label>}
      {unit && !fixed && <p>Preencha somente com um fator validado. Deixe em branco se a conversão estiver pendente.</p>}
      <label>Justificativa ou referência técnica <input name="reason" maxLength={500} required/></label>
      {error && <p role="alert">{error}</p>}
      <div className="customer-actions">
        <button disabled={busy}>{busy ? 'Salvando…' : 'Salvar configuração'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>Voltar</button>
      </div>
    </form>}
    {current.isError && <button className="secondary" onClick={onClose}>Voltar</button>}
    {product.classification === 'FABRICACAO_PROPRIA' && product.base_unit === 'un' && <PackagingConfig productId={product.id}/>}
  </section>
}
