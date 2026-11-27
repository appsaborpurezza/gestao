import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useIdempotentRpc } from '../../lib/catalog'
import { supabase } from '../../lib/supabase'
import { Combobox } from '../../ui/Combobox'
import { Modal } from '../../ui/records'
import { toast } from '../../ui/toast'

const units = ['kg', 'g', 'L', 'mL', 'un']
type Line = { key: string; item_id: string; source_name: string; quantity: string; unit: string }
type Material = { id: string; original_code: string; original_description: string; commercial_description: string | null; base_unit: string | null; active: boolean }
const newLine = (): Line => ({ key: crypto.randomUUID(), item_id: '', source_name: '', quantity: '', unit: '' })
const decimalPattern = '[0-9]+([,.][0-9]{1,6})?'

export type RecipeSource = { versionId: string; code: string; name: string; version: number }

/** Lista de insumos para o seletor, compartilhada com a ficha técnica. */
function useMaterials() {
  return useQuery({
    queryKey: ['recipes', 'materials'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('items')
        .select('id,original_code,original_description,commercial_description,base_unit,active')
        .in('classification', ['INSUMO', 'FARINHA_USO_REVENDA_A_VALIDAR']).order('original_code')
      if (error) throw error
      return data as Material[]
    },
  })
}

/** Cadastro rápido de insumo dentro da receita: os ingredientes já preenchidos são preservados. */
function QuickMaterial({ onCreated }: { onCreated: (id: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const { run, busy } = useIdempotentRpc()
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    event.stopPropagation()
    const form = new FormData(event.currentTarget)
    setError('')
    try {
      const id = await run<string>('save_operational_catalog', {
        catalog: 'INSUMO', target: null, expected_version: null,
        input: { label: String(form.get('label')).trim(), code: String(form.get('code')).trim(), unit: form.get('unit'), active: true },
      }, 'Não foi possível cadastrar o insumo.')
      await onCreated(id)
      toast('Insumo cadastrado e selecionado.')
      setOpen(false)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível cadastrar o insumo.') }
  }
  return <>
    <button type="button" className="secondary ui-quick-create" onClick={() => setOpen(true)}><Plus aria-hidden="true" size={16}/>Cadastrar insumo</button>
    <Modal open={open} title="Cadastrar insumo" onClose={() => { setOpen(false); setError('') }}>
      <form className="ui-form" onSubmit={save}>
        <label><span>Código interno <span className="ui-required" aria-hidden="true">*</span></span><input name="code" required maxLength={60} autoFocus autoComplete="off"/></label>
        <label><span>Descrição <span className="ui-required" aria-hidden="true">*</span></span><input name="label" required maxLength={180} autoComplete="off"/></label>
        <label><span>Unidade base <span className="ui-required" aria-hidden="true">*</span></span>
          <select name="unit" required defaultValue=""><option value="">Selecione</option>{units.map(unit => <option key={unit}>{unit}</option>)}</select></label>
        <p className="ui-muted">Os ingredientes já preenchidos na receita são preservados.</p>
        {error && <p className="ui-message" data-tone="danger" role="alert">{error}</p>}
        <div className="ui-modal-actions">
          <button type="button" className="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancelar</button>
          <button disabled={busy}>{busy ? 'Salvando…' : 'Cadastrar e selecionar'}</button>
        </div>
      </form>
    </Modal>
  </>
}

/**
 * Nova receita ou duplicação de uma existente. A receita nasce pendente de validação:
 * a ficha técnica (vínculos, etapas e tolerâncias) e a aprovação seguem pelo fluxo de revisão já existente.
 */
export function RecipeEditor({ source, onDirty, onSaved }: {
  source?: RecipeSource; onDirty: (dirty: boolean) => void; onSaved: (versionId: string, title: string) => void
}) {
  const cache = useQueryClient()
  const materials = useMaterials()
  const { run, busy } = useIdempotentRpc()
  const [lines, setLines] = useState<Line[]>([newLine(), newLine()])
  const [error, setError] = useState('')
  const options = (materials.data ?? []).map(item => ({
    value: item.id, label: `${item.original_code} · ${item.commercial_description ?? item.original_description}`,
    hint: item.base_unit ?? 'Unidade a validar', disabled: !item.active || !item.base_unit,
  }))
  const update = (key: string, patch: Partial<Line>) => { onDirty(true); setLines(current => current.map(line => line.key === key ? { ...line, ...patch } : line)) }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const code = String(form.get('code') ?? '').trim()
    const name = String(form.get('name') ?? '').trim()
    setError('')
    try {
      const id = source
        ? await run<string>('duplicate_recipe', { source_version: source.versionId, input: { code, name } }, 'Não foi possível duplicar a receita.')
        : await run<string>('create_recipe', { input: {
            code, name, yield_min: form.get('yield_min'), yield_target: form.get('yield_target'), yield_max: form.get('yield_max'),
            ingredients: lines.filter(line => line.item_id || line.source_name.trim())
              .map(({ item_id, source_name, quantity, unit }) => ({ item_id, source_name: source_name.trim(), quantity, unit })),
          } }, 'Não foi possível criar a receita.')
      toast(source ? 'Receita duplicada. Revise a ficha técnica.' : 'Receita criada. Complete a ficha técnica.')
      await cache.invalidateQueries({ queryKey: ['recipes'] })
      onSaved(id, name + ' · versão 1')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a receita.') }
  }

  return <form className="ui-form" onSubmit={save} onChange={() => onDirty(true)}>
    {source && <p className="ui-message">Cópia de <span className="ui-code">{source.code}</span> versão {source.version}. Ingredientes,
      rendimentos e ficha técnica são copiados como rascunho pendente. A aprovação, o estoque e as associações não são copiados.</p>}
    <fieldset className="ui-fieldset">
      <legend>Identificação</legend>
      <label><span>Código <span className="ui-required" aria-hidden="true">*</span></span><input name="code" required maxLength={60} autoComplete="off"/></label>
      <label><span>Nome <span className="ui-required" aria-hidden="true">*</span></span>
        <input name="name" required maxLength={180} defaultValue={source ? source.name + ' (cópia)' : ''}/></label>
    </fieldset>
    {!source && <>
      <fieldset className="ui-fieldset">
        <legend>Rendimento por massada (kg)</legend>
        <div className="ui-form-row">
          {([['yield_min', 'Mínimo'], ['yield_target', 'Médio'], ['yield_max', 'Máximo']] as const).map(([field, text]) =>
            <label key={field}><span>{text} <span className="ui-required" aria-hidden="true">*</span></span>
              <input name={field} required inputMode="decimal" pattern={decimalPattern}/></label>)}
        </div>
      </fieldset>
      <fieldset className="ui-fieldset">
        <legend>Ingredientes</legend>
        <p className="ui-muted">Escolha um insumo cadastrado ou escreva o nome como está na ficha. Vínculos, etapas e tolerâncias são completados na revisão técnica.</p>
        {lines.map((line, index) => <div key={line.key} className="recipe-line">
          <Combobox label={`Insumo ${index + 1}`} options={options} value={line.item_id}
            onChange={value => update(line.key, { item_id: value, unit: line.unit || (materials.data?.find(item => item.id === value)?.base_unit ?? '') })}/>
          {!line.item_id && <label>Nome na ficha<input value={line.source_name} maxLength={180} onChange={event => update(line.key, { source_name: event.target.value })}/></label>}
          <label>Quantidade<input inputMode="decimal" pattern={decimalPattern} value={line.quantity} onChange={event => update(line.key, { quantity: event.target.value })}/></label>
          <label>Unidade<select value={line.unit} required={Boolean(line.item_id || line.source_name.trim())} onChange={event => update(line.key, { unit: event.target.value })}>
            <option value="">Selecione</option>{units.map(unit => <option key={unit}>{unit}</option>)}</select></label>
          <button type="button" className="icon-button" aria-label={`Remover ingrediente ${index + 1}`} disabled={lines.length === 1}
            onClick={() => { onDirty(true); setLines(current => current.filter(item => item.key !== line.key)) }}><Trash2 aria-hidden="true" size={16}/></button>
        </div>)}
        <div className="ui-inline-actions">
          <button type="button" className="secondary" onClick={() => { onDirty(true); setLines(current => [...current, newLine()]) }}><Plus aria-hidden="true" size={16}/>Adicionar ingrediente</button>
          <QuickMaterial onCreated={async id => {
            const fresh = await materials.refetch()
            const unit = fresh.data?.find(item => item.id === id)?.base_unit ?? ''
            onDirty(true)
            setLines(current => {
              const empty = current.find(line => !line.item_id && !line.source_name.trim())
              return empty ? current.map(line => line.key === empty.key ? { ...line, item_id: id, unit } : line) : [...current, { ...newLine(), item_id: id, unit }]
            })
          }}/>
        </div>
      </fieldset>
    </>}
    {error && <p className="ui-message" data-tone="danger" role="alert">{error}</p>}
    <div className="ui-modal-actions"><button disabled={busy}>{busy ? 'Salvando…' : source ? 'Duplicar receita' : 'Criar receita'}</button></div>
  </form>
}
