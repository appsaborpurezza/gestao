import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2, Link2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { CatalogLifecycleDialog, useLifecycle } from '../../ui/records'
import { Badge } from '../../ui'

type ConfigVersion = { id: string; version: number; packages_per_unit: number; labels_per_unit: number; reference: string; configured_at: string }

/**
 * Todas as versões da configuração. A mais recente vale para novas ordens; as anteriores ficam congeladas nas OPs.
 * Excluir só é aceito pelo banco para versão nunca usada em OP, reserva ou saída de acabado.
 */
function PackagingVersions({ productId }: { productId: string }) {
  const cache = useQueryClient()
  const lifecycle = useLifecycle()
  const versions = useQuery({
    queryKey: ['items', 'packing-config', productId, 'versions'],
    queryFn: async () => {
      const { data, error } = await supabase.from('product_packaging_configs')
        .select('id,version,packages_per_unit,labels_per_unit,reference,configured_at').eq('product_id', productId).order('version', { ascending: false })
      if (error) throw error
      return data as ConfigVersion[]
    },
  })
  if (!versions.data?.length) return null
  return <section aria-label="Versões da configuração">
    <h4>Versões registradas</h4>
    <ul className="ui-dependency-list">
      {versions.data.map((item, index) => <li key={item.id}>
        <span>Versão {item.version} · {item.packages_per_unit} embalagem(ns) e {item.labels_per_unit} etiqueta(s) por unidade
          <small className="ui-muted"> · {new Date(item.configured_at).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} · {item.reference}</small></span>
        <span className="ui-inline-actions">
          {index === 0 ? <Badge tone="success">Vigente</Badge> : <Badge tone="neutral">Anterior</Badge>}
          <button type="button" className="icon-button" aria-label={`Dependências da versão ${item.version}`} title="Dependências"
            onClick={() => lifecycle.open(item.id, 'dependencies')}><Link2 aria-hidden="true" size={16}/></button>
          <button type="button" className="icon-button" aria-label={`Excluir versão ${item.version}`} title="Excluir versão"
            onClick={() => lifecycle.open(item.id, 'delete')}><Trash2 aria-hidden="true" size={16}/></button>
        </span>
      </li>)}
    </ul>
    <CatalogLifecycleDialog entity="CONFIG_EMBALAGEM" recordId={lifecycle.recordId} mode={lifecycle.mode} onClose={lifecycle.close}
      onModeChange={lifecycle.setMode} onDone={() => { lifecycle.close(); void cache.invalidateQueries({ queryKey: ['items', 'packing-config', productId] }) }}/>
  </section>
}

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
      <PackagingVersions productId={productId}/>
    </>}
  </details>
}
