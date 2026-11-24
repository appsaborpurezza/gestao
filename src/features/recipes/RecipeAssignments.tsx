import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'

export function RecipeAssignments() {
  const cache = useQueryClient()
  const [product, setProduct] = useState('')
  const [scope, setScope] = useState<'CLIENTE' | 'PADRAO'>('CLIENTE')
  const [customer, setCustomer] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null)
  const [endRule, setEndRule] = useState(false)
  const request = useRef<{ fingerprint: string; id: string } | null>(null)
  const inFlight = useRef(false)

  const options = useQuery({
    queryKey: ['recipes', 'assignment-options'],
    queryFn: async () => {
      const [products, customers, recipes] = await Promise.all([
        supabase.from('items').select('id,original_code,original_description')
          .eq('classification', 'FABRICACAO_PROPRIA').eq('active', true).order('original_code'),
        supabase.from('customers').select('id,customer_number,legal_name,active').order('legal_name').order('customer_number'),
        supabase.from('recipes').select('id,name,recipe_versions(id,version,status)').order('name'),
      ])
      if (products.error || customers.error || recipes.error) throw products.error ?? customers.error ?? recipes.error
      return {
        products: products.data!, customers: customers.data!,
        versions: recipes.data!.flatMap(recipe => recipe.recipe_versions.filter(version => version.status === 'APROVADA')
          .map(version => ({ id: version.id, label: recipe.name + ' · versão ' + version.version }))),
      }
    },
  })
  const rule = useQuery({
    queryKey: ['recipes', 'current-assignment', product, scope, customer],
    enabled: Boolean(product && (scope === 'PADRAO' || customer)),
    queryFn: async () => {
      const query = supabase.from('customer_product_recipes').select('id,recipe_version_id,reason')
        .eq('product_id', product).eq('scope', scope).is('ends_at', null)
      if (scope === 'PADRAO') query.is('customer_id', null)
      else query.eq('customer_id', customer)
      const { data, error } = await query.maybeSingle()
      if (error) throw error
      return data
    },
  })

  function resetFeedback() {
    setFeedback(null)
    setEndRule(false)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current || !rule.isSuccess) return
    const fields = new FormData(event.currentTarget)
    const params = {
      target_product: product,
      target_customer: scope === 'CLIENTE' ? customer : null,
      rule_scope: scope,
      target_version: endRule ? null : fields.get('recipe'),
      expected_assignment: rule.data?.id ?? null,
      reason: fields.get('reason'),
    }
    const fingerprint = JSON.stringify(params)
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setFeedback(null)
    try {
      const { error } = await supabase.rpc('save_recipe_assignment', { ...params, request_id: request.current.id })
      if (error) {
        if (error.code === '40001') await rule.refetch()
        throw new Error(error.message)
      }
      request.current = null
      setEndRule(false)
      await cache.invalidateQueries({ queryKey: ['recipes'] })
      setFeedback({ text: endRule ? 'Associação encerrada.' : 'Associação salva.', error: false })
    } catch (cause) {
      setFeedback({ text: cause instanceof Error ? cause.message : 'Falha ao salvar a associação.', error: true })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const criteriaReady = Boolean(product && (scope === 'PADRAO' || customer))
  return <section className="panel">
    <h1>Associações de receitas</h1>
    <p>Cadastre uma versão aprovada para o cliente e produto ou autorize uma versão padrão para o produto.</p>
    {options.isPending && <p role="status">Carregando cadastros…</p>}
    {options.isError && <p role="alert">Falha ao consultar produtos, clientes e receitas.</p>}
    {options.data && <>
      <div className="customer-fields">
        <label>Produto <select value={product} disabled={busy} onChange={event => { setProduct(event.target.value); resetFeedback() }}>
          <option value="">Selecione</option>{options.data.products.map(row => <option key={row.id} value={row.id}>
            {row.original_code} · {row.original_description}
          </option>)}
        </select></label>
        <label>Aplicação <select value={scope} disabled={busy} onChange={event => {
          setScope(event.target.value === 'PADRAO' ? 'PADRAO' : 'CLIENTE')
          resetFeedback()
        }}>
          <option value="CLIENTE">Cliente específico</option><option value="PADRAO">Receita padrão do produto</option>
        </select></label>
        {scope === 'CLIENTE' && <label>Cliente <select value={customer} disabled={busy} onChange={event => {
          setCustomer(event.target.value)
          resetFeedback()
        }}>
          <option value="">Selecione</option>{options.data.customers.map(row => <option key={row.id} value={row.id}>
            {row.customer_number} · {row.legal_name}{!row.active && ' (inativo)'}
          </option>)}
        </select></label>}
      </div>
      {criteriaReady && rule.isPending && <p role="status">Consultando associação vigente…</p>}
      {criteriaReady && rule.isError && <p role="alert">Falha ao consultar a associação.</p>}
      {criteriaReady && rule.isSuccess && <>
        <p>{rule.data ? 'Regra vigente: ' + (options.data.versions.find(version => version.id === rule.data?.recipe_version_id)?.label
          ?? 'Versão indisponível') : 'Nenhuma regra vigente para esta seleção.'}</p>
        {rule.data && <label className="customer-check">
          <input type="checkbox" checked={endRule} disabled={busy} onChange={event => setEndRule(event.target.checked)}/> Encerrar regra vigente
        </label>}
        {(endRule || options.data.versions.length > 0) ? <form onSubmit={save} key={product + '/' + scope + '/' + customer + '/' + (rule.data?.id ?? '') + '/' + endRule}>
          {!endRule && <label>Versão aprovada <select name="recipe" required defaultValue={rule.data?.recipe_version_id ?? ''}>
            <option value="">Selecione</option>{options.data.versions.map(version => <option key={version.id} value={version.id}>{version.label}</option>)}
          </select></label>}
          <label>Justificativa ou referência <input name="reason" required maxLength={500}/></label>
          <button disabled={busy}>{busy ? 'Salvando…' : endRule ? 'Encerrar associação' : 'Salvar associação'}</button>
        </form> : <p>Aprove uma ficha técnica para cadastrar uma associação.</p>}
      </>}
    </>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
  </section>
}
