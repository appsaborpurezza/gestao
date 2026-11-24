import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'

type Source = { id: string; ordinal: number; source_name: string; quantity: string | null; unit: string }
const units = ['kg', 'g', 'L', 'mL', 'un']
const fields = [
  ['yield_min', 'Rendimento mínimo (kg)'], ['yield_target', 'Rendimento médio (kg)'], ['yield_max', 'Rendimento máximo (kg)'],
] as const
const decimalPattern = '[0-9]+([,.][0-9]{1,6})?'

export function RecipeReview({ versionId, title, canEdit, canApprove, onClose }: {
  versionId: string; title: string; canEdit: boolean; canApprove: boolean; onClose: () => void
}) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [approvalError, setApprovalError] = useState('')
  const inFlight = useRef(false)
  const pending = useRef<{ payload: string; version: number | null; id: string } | null>(null)
  const approvalRequest = useRef<{ payload: string; id: string } | null>(null)
  const query = useQuery({
    queryKey: ['recipes', 'review', versionId],
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 0,
    queryFn: async () => {
      const [source, draft, draftItems, materials, approval] = await Promise.all([
        supabase.from('recipe_ingredients').select('id,ordinal,source_name,quantity::text,unit')
          .eq('recipe_version_id', versionId).order('ordinal'),
        supabase.from('recipe_reviews').select('edit_version,yield_min::text,yield_target::text,yield_max::text,shelf_life_days,storage_conditions,water_control_reference,review_reference')
          .eq('recipe_version_id', versionId).maybeSingle(),
        supabase.from('recipe_review_ingredients')
          .select('source_ingredient_id,item_id,quantity::text,unit,stage,lower_tolerance::text,upper_tolerance::text,technical_reference')
          .eq('recipe_version_id', versionId),
        supabase.from('items').select('id,original_code,original_description,commercial_description,base_unit,active')
          .in('classification', ['INSUMO', 'FARINHA_USO_REVENDA_A_VALIDAR']).order('original_code'),
        supabase.from('recipe_approvals').select('approved_at,approval_reference,review_version')
          .eq('recipe_version_id', versionId).maybeSingle(),
      ])
      if (source.error || draft.error || draftItems.error || materials.error || approval.error) {
        throw source.error ?? draft.error ?? draftItems.error ?? materials.error ?? approval.error
      }
      return { source: source.data as Source[], draft: draft.data, draftItems: draftItems.data!,
        materials: materials.data!, approval: approval.data }
    },
  })
  const editable = canEdit && !query.data?.approval

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!query.data || inFlight.current || !editable) return
    const data = new FormData(event.currentTarget)
    const decimal = (field: string) => String(data.get(field) ?? '').replace(',', '.')
    const input = {
      yield_min: decimal('yield_min'), yield_target: decimal('yield_target'), yield_max: decimal('yield_max'),
      shelf_life_days: data.get('shelf_life_days'), storage_conditions: data.get('storage_conditions'),
      water_control_reference: data.get('water_control_reference'), review_reference: data.get('review_reference'),
      ingredients: query.data.source.map(source => ({
        source_ingredient_id: source.id, item_id: data.get(source.id + '-item'), quantity: decimal(source.id + '-quantity'),
        unit: data.get(source.id + '-unit'), stage: data.get(source.id + '-stage'),
        lower_tolerance: decimal(source.id + '-lower'), upper_tolerance: decimal(source.id + '-upper'),
        technical_reference: data.get(source.id + '-reference'),
      })),
    }
    const payload = JSON.stringify(input)
    const version = query.data.draft?.edit_version ?? null
    if (pending.current?.payload !== payload || pending.current.version !== version) {
      pending.current = { payload, version, id: crypto.randomUUID() }
    }
    inFlight.current = true
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      const { error } = await supabase.rpc('save_recipe_review', {
        target_version: versionId, expected_version: version, input, request_id: pending.current.id,
      })
      if (error) throw new Error(error.code === '23514' ? 'Confira rendimentos, validade e tolerâncias.' : error.message)
      pending.current = null
      await cache.invalidateQueries({ queryKey: ['recipes', 'review', versionId] })
      setSaved(true)
      setDirty(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao salvar a ficha técnica.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!query.data?.draft || !canApprove || query.data.approval || dirty || inFlight.current) return
    const params = {
      target_version: versionId,
      expected_review_version: query.data.draft.edit_version,
      reference: new FormData(event.currentTarget).get('reference'),
    }
    const payload = JSON.stringify(params)
    if (approvalRequest.current?.payload !== payload) approvalRequest.current = { payload, id: crypto.randomUUID() }
    setApprovalError('')
    inFlight.current = true
    setBusy(true)
    try {
      const { error } = await supabase.rpc('approve_recipe_version', {
        ...params, request_id: approvalRequest.current.id,
      })
      if (error) throw new Error(error.message)
      await cache.invalidateQueries({ queryKey: ['recipes'] })
    } catch (cause) {
      setApprovalError(cause instanceof Error ? cause.message : 'Falha ao aprovar a ficha.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <section>
    <button type="button" className="secondary" disabled={busy} onClick={onClose}>Voltar às receitas</button>
    <h2>{query.data?.approval ? 'Ficha técnica aprovada' : 'Ficha técnica em revisão'}</h2>
    <p>{title}</p>
    {query.data?.approval ? <p role="status">Aprovada em {new Date(query.data.approval.approved_at).toLocaleString('pt-BR',
      { timeZone: 'America/Sao_Paulo' })} · {query.data.approval.approval_reference}. Alterações exigem nova versão.</p>
      : <p>Preencha somente os dados conferidos. A fórmula de origem está preservada e a receita continua pendente de validação.</p>}
    {query.isPending && <p role="status">Carregando ficha técnica…</p>}
    {query.isError && <p role="alert">Falha ao consultar a ficha técnica.</p>}
    {query.data && !query.data.draft && !canEdit && <p>Esta versão ainda não tem ficha técnica registrada.</p>}
    {query.data && (canEdit || query.data.draft) && <form onSubmit={save} onChange={() => { setSaved(false); setDirty(true) }}
      key={query.data.draft?.edit_version ?? 'new'}>
      <fieldset disabled={!editable || busy}>
        <legend>Rendimento, validade e armazenamento</legend>
        <div className="customer-fields">
          {fields.map(([name, label]) => <label key={name}>{label}
            <input name={name} inputMode="decimal" pattern={decimalPattern} defaultValue={query.data.draft?.[name] ?? ''}/>
          </label>)}
          <label>Validade em dias <input name="shelf_life_days" type="number" min="1" step="1"
            defaultValue={query.data.draft?.shelf_life_days ?? ''}/></label>
          <label>Condições de armazenamento <input name="storage_conditions" maxLength={1000}
            defaultValue={query.data.draft?.storage_conditions ?? ''}/></label>
          <label>Referência do controle da água <input name="water_control_reference" maxLength={500}
            defaultValue={query.data.draft?.water_control_reference ?? ''}/></label>
          <label>Referência da revisão <input name="review_reference" maxLength={500}
            defaultValue={query.data.draft?.review_reference ?? ''}/></label>
        </div>
      </fieldset>
      {query.data.source.map(source => {
        const draft = query.data.draftItems.find(item => item.source_ingredient_id === source.id)
        const materials = query.data.materials.filter(item => item.active || item.id === draft?.item_id)
        return <fieldset key={source.id} disabled={!editable || busy}>
          <legend>{source.source_name}</legend>
          <p>Transcrição: {source.quantity === null ? 'Quantidade a validar' : formatStockQuantity(source.quantity) + ' ' + source.unit}</p>
          <div className="customer-fields">
            <label>Insumo vinculado <select name={source.id + '-item'} defaultValue={draft?.item_id ?? ''}>
              <option value="">Sem vínculo</option>{materials.map(item => <option key={item.id} value={item.id} disabled={!item.active || !item.base_unit}>
                {item.original_code} · {item.commercial_description ?? item.original_description} · {item.base_unit ?? 'A validar'}
              </option>)}
            </select></label>
            <label>Quantidade por massada <input name={source.id + '-quantity'} inputMode="decimal"
              pattern={decimalPattern} defaultValue={draft?.quantity ?? ''}/></label>
            <label>Unidade <select name={source.id + '-unit'} defaultValue={draft?.unit ?? ''}>
              <option value="">A validar</option>{units.map(unit => <option key={unit}>{unit}</option>)}
            </select></label>
            <label>Etapa <select name={source.id + '-stage'} defaultValue={draft?.stage ?? ''}>
              <option value="">A validar</option><option value="PREPARACAO">Preparação</option><option value="BATER_MASSA">Bater massa</option>
            </select></label>
            <label>Tolerância abaixo da quantidade-alvo <input name={source.id + '-lower'} inputMode="decimal"
              pattern={decimalPattern} defaultValue={draft?.lower_tolerance ?? ''}/></label>
            <label>Tolerância acima da quantidade-alvo <input name={source.id + '-upper'} inputMode="decimal"
              pattern={decimalPattern} defaultValue={draft?.upper_tolerance ?? ''}/></label>
            <label>Referência técnica do ingrediente <input name={source.id + '-reference'} maxLength={500}
              defaultValue={draft?.technical_reference ?? ''}/></label>
          </div>
        </fieldset>
      })}
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Ficha técnica salva para revisão.</p>}
      {editable && <button disabled={busy}>{busy ? 'Aguarde…' : 'Salvar ficha técnica'}</button>}
    </form>}
    {canApprove && query.data?.draft && !query.data.approval && <details>
      <summary>Aprovação técnica</summary>
      <p>A aprovação torna esta ficha imutável. Confira os dados salvos antes de confirmar.</p>
      {dirty && <p>Salve a ficha antes de aprovar.</p>}
      <form onSubmit={approve}>
        <label>Referência formal da aprovação <input name="reference" maxLength={500} required/></label>
        {approvalError && <p role="alert">{approvalError}</p>}
        <button disabled={busy || dirty}>Aprovar versão salva</button>
      </form>
    </details>}
  </section>
}
