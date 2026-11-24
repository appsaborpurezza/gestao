import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'

type Plan = {
  requested_kg: string
  net_kg: string
  simulated_stock_kg: string
  yield_kg: string
  batches: string
  min_output_kg: string
  target_output_kg: string
  max_output_kg: string
  risk_kg: string
  expected_surplus_kg: string
  recipe_status: string
  flour_kg: string | null
  flour_sacks_25kg: string | null
  ingredients: { name: string; unit: string; per_batch: string | null; planned_quantity: string | null }[]
}

const kg = (value: string) => formatStockQuantity(value) + ' kg'

export function PlanSimulation({ demandId, title, onClose }: { demandId: string; title: string; onClose: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [scenario, setScenario] = useState<{ recipe: string; mode: string; associationId: string | null; realStock: boolean } | null>(null)
  const [stockMode, setStockMode] = useState<'real' | 'hypothetical'>('real')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const cache = useQueryClient()
  const orderRequest = useRef<{ payload: string; id: string } | null>(null)
  const [openingError, setOpeningError] = useState('')
  const [showBatches, setShowBatches] = useState(false)
  const recipes = useQuery({
    queryKey: ['recipes', 'simulation'],
    queryFn: async () => {
      const { data, error } = await supabase.from('recipes')
        .select('id,name,recipe_versions(id,version,status)').order('name')
      if (error) throw error
      return data.flatMap(recipe => [...recipe.recipe_versions].sort((a, b) => b.version - a.version)
        .map(version => ({ id: version.id, label: recipe.name + ' · versão ' + version.version
          + (version.status === 'APROVADA' ? ' · aprovada' : ' · pendente') })))
    },
  })
  const association = useQuery({
    queryKey: ['recipes', 'demand-assignment', demandId],
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('resolve_demand_recipe', { target_demand: demandId })
      if (error) throw error
      return data as { assignment_id: string; recipe_version_id: string; recipe_name: string; recipe_number: number;
        scope: 'CLIENTE' | 'PADRAO' } | null
    },
  })
  const order = useQuery({
    queryKey: ['orders', 'production-order', demandId],
    queryFn: async () => {
      const { data, error } = await supabase.from('production_orders')
        .select('id,production_number,recipe_name,yield_mode,target_kg::text,yield_kg::text,batches_count,status')
        .eq('demand_id', demandId).maybeSingle()
      if (error) throw error
      return data
    },
  })
  const coverage = useQuery({
    queryKey: ['orders', 'actual-demand-coverage', demandId],
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('demand_stock_coverage', { target_demand: demandId })
      if (error) throw error
      return data as string
    },
  })
  const batches = useQuery({
    queryKey: ['orders', 'production-batches', order.data?.id],
    enabled: Boolean(order.data?.id && showBatches),
    queryFn: async () => {
      const { data, error } = await supabase.from('production_batches').select('id,sequence,status')
        .eq('production_order_id', order.data!.id).order('sequence')
      if (error) throw error
      return data
    },
  })

  async function simulate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const fields = new FormData(event.currentTarget)
    if (stockMode === 'real' && !coverage.isSuccess) return
    inFlight.current = true
    setBusy(true)
    setError('')
    setPlan(null)
    setScenario(null)
    setOpeningError('')
    try {
      const recipe = String(fields.get('recipe') ?? '')
      const mode = String(fields.get('yield_mode') ?? '')
      const { data, error } = await supabase.rpc('calculate_production_plan', {
        target_demand: demandId,
        target_recipe_version: recipe,
        yield_mode: mode,
        simulated_stock_kg: stockMode === 'real' ? coverage.data : String(fields.get('stock') ?? '0').replace(',', '.'),
      })
      if (error) throw new Error(error.message)
      setPlan(data as Plan)
      setScenario({ recipe, mode, associationId: association.data?.assignment_id ?? null, realStock: stockMode === 'real' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao simular o planejamento.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const canOpen = order.isSuccess && !order.data && scenario?.associationId
    && scenario.associationId === association.data?.assignment_id
    && scenario.recipe === association.data.recipe_version_id && plan?.recipe_status === 'APROVADA'
    && scenario.realStock && Number(plan.net_kg) > 0

  async function openOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canOpen || !scenario || inFlight.current) return
    const params = {
      target_demand: demandId,
      expected_assignment: scenario.associationId,
      yield_mode: scenario.mode,
      reason: new FormData(event.currentTarget).get('reason'),
    }
    const payload = JSON.stringify(params)
    if (orderRequest.current?.payload !== payload) orderRequest.current = { payload, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setOpeningError('')
    try {
      const { error } = await supabase.rpc('create_production_order', { ...params, request_id: orderRequest.current.id })
      if (error) {
        if (error.code === '40001') await association.refetch()
        if (error.code === '23505') await order.refetch()
        throw new Error(error.message)
      }
      await cache.invalidateQueries({ queryKey: ['orders'] })
    } catch (cause) {
      setOpeningError(cause instanceof Error ? cause.message : 'Falha ao abrir a ordem de produção.')
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  return <section>
    <button type="button" className="secondary" onClick={onClose}>Voltar às demandas</button>
    <h2>Simulação de massadas</h2>
    <p>{title}</p>
    {order.isError && <p role="alert">Falha ao consultar a ordem de produção.</p>}
    {order.data && <article>
      <h3>OP {order.data.production_number} · {order.data.status}</h3>
      <p>{order.data.recipe_name} · {order.data.batches_count} massadas · necessidade líquida de {kg(order.data.target_kg)}
        {' · '}cálculo com {kg(order.data.yield_kg)} por massada.</p>
      <details onToggle={event => setShowBatches(event.currentTarget.open)}>
        <summary>Massadas planejadas</summary>
        {batches.isFetching && <p role="status">Carregando massadas…</p>}
        {batches.isError && <p role="alert">Falha ao consultar as massadas.</p>}
        {batches.data && <ol>{batches.data.map(batch => <li key={batch.id}>Massada {batch.sequence} · {batch.status}</li>)}</ol>}
      </details>
    </article>}
    {(recipes.isPending || association.isPending) && <p role="status">Carregando receitas e associação…</p>}
    {(recipes.isError || association.isError) && <p role="alert">Falha ao consultar as receitas ou a associação.</p>}
    {association.isSuccess && <p>{association.data
      ? 'Receita associada: ' + association.data.recipe_name + ' · versão ' + association.data.recipe_number
        + (association.data.scope === 'CLIENTE' ? ' · regra do cliente' : ' · padrão do produto')
      : 'Nenhuma associação vigente. A seleção manual pode ser usada para simulação.'}</p>}
    {recipes.data?.length === 0 && <p>Nenhuma receita cadastrada para simular.</p>}
    {!!recipes.data?.length && association.isSuccess && <form onSubmit={simulate}
      onChange={() => { setPlan(null); setScenario(null); setError(''); setOpeningError('') }}>
      <fieldset disabled={busy} className="customer-fields">
        <label>Receita para simulação <select name="recipe" defaultValue={association.data?.recipe_version_id ?? ''} required>
          <option value="">Selecione</option>
          {recipes.data.map(recipe => <option key={recipe.id} value={recipe.id}>{recipe.label}</option>)}
        </select></label>
        <label>Cenário <select name="yield_mode" defaultValue="MEDIO">
          <option value="MEDIO">Rendimento médio</option><option value="CONSERVADOR">Rendimento mínimo</option>
        </select></label>
        <label>Cobertura da demanda <select value={stockMode}
          onChange={event => setStockMode(event.target.value === 'hypothetical' ? 'hypothetical' : 'real')}>
          <option value="real">Estoque reservado ou despachado</option>
          <option value="hypothetical">Estoque hipotético</option>
        </select></label>
        {stockMode === 'hypothetical' && <label>Estoque compatível hipotético (kg) <input name="stock" inputMode="decimal"
          pattern="[0-9]+([,.][0-9]{1,9})?" defaultValue="0" required/></label>}
      </fieldset>
      {stockMode === 'real' && coverage.isPending && <p role="status">Consultando cobertura real…</p>}
      {stockMode === 'real' && coverage.isError && <p role="alert">Falha ao consultar a cobertura real.</p>}
      {stockMode === 'real' && coverage.isSuccess && <p>Cobertura atual: {kg(coverage.data)}.</p>}
      <button disabled={busy || (stockMode === 'real' && !coverage.isSuccess)}>{busy ? 'Calculando…' : 'Calcular massadas'}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    {plan && <section aria-label="Resultado da simulação">
      {plan.recipe_status !== 'APROVADA' && <p>Simulação com receita pendente de validação.</p>}
      <h3>{formatStockQuantity(plan.batches)} massadas inteiras</h3>
      <dl>
        <dt>Demanda</dt><dd>{kg(plan.requested_kg)}</dd>
        <dt>{scenario?.realStock ? 'Estoque reservado ou despachado considerado' : 'Estoque hipotético considerado'}</dt><dd>{kg(plan.simulated_stock_kg)}</dd>
        <dt>Necessidade líquida</dt><dd>{kg(plan.net_kg)}</dd>
        <dt>Rendimento usado por massada</dt><dd>{kg(plan.yield_kg)}</dd>
        <dt>Produção mínima, média e máxima</dt><dd>{kg(plan.min_output_kg)} · {kg(plan.target_output_kg)} · {kg(plan.max_output_kg)}</dd>
        <dt>Risco de falta no rendimento mínimo</dt><dd>{kg(plan.risk_kg)}</dd>
        <dt>Excedente previsto no cenário</dt><dd>{kg(plan.expected_surplus_kg)}</dd>
        <dt>Farinha de trigo prevista</dt><dd>{plan.flour_kg === null ? 'A validar' : kg(plan.flour_kg)}
          {plan.flour_sacks_25kg !== null && ' · equivalente a ' + formatStockQuantity(plan.flour_sacks_25kg) + ' sacos de 25 kg'}
        </dd>
      </dl>
      {plan.risk_kg !== '0' && Number(plan.risk_kg) > 0 && <p role="status">O rendimento mínimo pode deixar parte do pedido sem cobertura.</p>}
      <h3>Ingredientes previstos</h3>
      <div className="table-scroll"><table>
        <thead><tr><th>Ingrediente</th><th>Por massada</th><th>Total previsto</th></tr></thead>
        <tbody>{plan.ingredients.map((ingredient, index) => <tr key={index}>
          <td>{ingredient.name}</td>
          <td>{ingredient.per_batch === null ? 'A validar' : formatStockQuantity(ingredient.per_batch) + ' ' + ingredient.unit}</td>
          <td>{ingredient.planned_quantity === null ? 'A validar' : formatStockQuantity(ingredient.planned_quantity) + ' ' + ingredient.unit}</td>
        </tr>)}</tbody>
      </table></div>
      <p>Embalagens e disponibilidade de insumos ainda precisam ser conferidas.</p>
      {canOpen && <form onSubmit={openOrder}>
        <p>O servidor revalida a cobertura real e planeja somente a quantidade que ainda falta.</p>
        <label>Justificativa do planejamento <input name="reason" maxLength={500} required/></label>
        <button disabled={busy}>{busy ? 'Aguarde…' : 'Abrir ordem de produção'}</button>
      </form>}
      {openingError && <p role="alert">{openingError}</p>}
    </section>}
  </section>
}
