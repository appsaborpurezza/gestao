import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'

export function PackagingConfig({ productId }: { productId: string }) {
  const cache = useQueryClient()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null)
  const inFlight = useRef(false)
  const request = useRef<{ fingerprint: string; id: string } | null>(null)
  const options = useQuery({
    queryKey: ['items', 'packing-config', productId],
    enabled: open,
    queryFn: async () => {
      const [config, makers, materials] = await Promise.all([
        supabase.from('product_packaging_configs')
          .select('id,version,manufacturer_id,package_item_id,label_item_id,packages_per_unit,labels_per_unit')
          .eq('product_id', productId).order('version', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('manufacturers').select('id,name,active').order('name'),
        supabase.from('items').select('id,original_code,original_description,active')
          .eq('classification', 'INSUMO').eq('base_unit', 'un').order('original_code'),
      ])
      if (config.error || makers.error || materials.error) throw config.error ?? makers.error ?? materials.error
      return { config: config.data, makers: makers.data!, materials: materials.data! }
    },
  })

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!options.data || inFlight.current) return
    const input = Object.fromEntries(new FormData(event.currentTarget))
    const params = { target_product: productId, expected_config: options.data.config?.id ?? null, input }
    const fingerprint = JSON.stringify(params)
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
    setBusy(true)
    setFeedback(null)
    inFlight.current = true
    try {
      const { error } = await supabase.rpc('save_packaging_config', { ...params, request_id: request.current.id })
      if (error) throw new Error(error.message)
      await cache.invalidateQueries({ queryKey: ['items', 'packing-config', productId] })
      setFeedback({ message: 'Configuração de embalagem salva.', error: false })
    } catch (cause) {
      setFeedback({ message: cause instanceof Error ? cause.message : 'Falha ao salvar a embalagem.', error: true })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Configurar embalagem e etiqueta</summary>
    {open && <>
      {options.isPending && <p role="status">Carregando fabricantes e insumos…</p>}
      {options.isError && <p role="alert">Falha ao consultar a configuração.</p>}
      {options.data && <form onSubmit={save} key={options.data.config?.id ?? 'new'}>
        <p>Use as quantidades aprovadas por unidade de produto. A última configuração vale para novas ordens.</p>
        <label>Fabricante do produto acabado <select name="manufacturer_id" required defaultValue={options.data.config?.manufacturer_id ?? ''}>
          <option value="">Selecione</option>{options.data.makers.map(maker => <option key={maker.id} value={maker.id} disabled={!maker.active}>{maker.name}</option>)}
        </select></label>
        {(['package', 'label'] as const).map(kind => <fieldset key={kind}>
          <legend>{kind === 'package' ? 'Embalagem' : 'Etiqueta'}</legend>
          <label>Insumo <select name={kind + '_item_id'} required defaultValue={options.data!.config?.[kind === 'package' ? 'package_item_id' : 'label_item_id'] ?? ''}>
            <option value="">Selecione</option>{options.data!.materials.map(item => <option key={item.id} value={item.id} disabled={!item.active}>
              {item.original_code} · {item.original_description}
            </option>)}
          </select></label>
          <label>Quantidade por unidade de produto <input name={kind === 'package' ? 'packages_per_unit' : 'labels_per_unit'}
            type="number" min="1" step="1" required defaultValue={options.data!.config?.[kind === 'package' ? 'packages_per_unit' : 'labels_per_unit'] ?? ''}/></label>
        </fieldset>)}
        <label>Referência da configuração <input name="reference" required maxLength={500}/></label>
        <button disabled={busy}>{busy ? 'Salvando…' : 'Salvar nova configuração'}</button>
      </form>}
      {feedback && <p role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
    </>}
  </details>
}
