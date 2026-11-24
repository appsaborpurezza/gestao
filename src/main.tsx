import { lazy, Suspense, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { Access } from './features/auth/Access'
import { supabase } from './lib/supabase'
import './styles.css'

const ImportForm = lazy(() => import('./features/import/ImportForm').then(module => ({ default: module.ImportForm })))
const Inventory = lazy(() => import('./features/inventory/Inventory').then(module => ({ default: module.Inventory })))
const Customers = lazy(() => import('./features/customers/Customers').then(module => ({ default: module.Customers })))
const Orders = lazy(() => import('./features/orders/Orders').then(module => ({ default: module.Orders })))
const ProductionDemand = lazy(() => import('./features/orders/ProductionDemand').then(module => ({ default: module.ProductionDemand })))
const ProductUnits = lazy(() => import('./features/products/ProductUnits').then(module => ({ default: module.ProductUnits })))
const Shipping = lazy(() => import('./features/orders/Shipping').then(module => ({ default: module.Shipping })))
const Traceability = lazy(() => import('./features/inventory/Traceability').then(module => ({ default: module.Traceability })))
const Recall = lazy(() => import('./features/inventory/Recall').then(module => ({ default: module.Recall })))
const Losses = lazy(() => import('./features/production/Losses').then(module => ({ default: module.Losses })))
const OperationalCatalogs = lazy(() => import('./features/inventory/OperationalCatalogs').then(module => ({ default: module.OperationalCatalogs })))
const RecipeReview = lazy(() => import('./features/recipes/RecipeReview').then(module => ({ default: module.RecipeReview })))
const RecipeAssignments = lazy(() => import('./features/recipes/RecipeAssignments').then(module => ({ default: module.RecipeAssignments })))
const ProductionBoard = lazy(() => import('./features/production/ProductionBoard').then(module => ({ default: module.ProductionBoard })))
const Dashboard = lazy(() => import('./features/dashboard/Dashboard'))

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })

function Workspace({ userId }: { userId: string }) {
  const [tab, setTab] = useState('dashboard')
  const [unitItem, setUnitItem] = useState<string | null>(null)
  const [recipeReview, setRecipeReview] = useState<{ id: string; title: string } | null>(null)
  const profile = useQuery({
    queryKey: ['profile', userId],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('display_name,role,can_release_lot,can_approve_recipe').eq('id', userId).maybeSingle()
      if (error) throw error
      return data
    },
  })
  const catalog = useQuery({
    queryKey: ['items', userId],
    enabled: !!profile.data && tab === 'products',
    queryFn: async () => {
      const { data, error } = await supabase.from('items')
        .select('id,original_code,original_description,commercial_description,classification,validation_status,base_unit,unit_version')
        .order('original_code')
      if (error) throw error
      return data.sort((a, b) => a.original_code.localeCompare(b.original_code, 'pt-BR', { numeric: true }))
    },
  })
  const recipes = useQuery({
    queryKey: ['recipes', userId],
    enabled: !!profile.data && profile.data.role !== 'VENDAS' && tab === 'recipes',
    queryFn: async () => {
      const { data, error } = await supabase.from('recipes')
        .select('id,code,name,recipe_versions(id,version,status,yield_min,yield_target,yield_max,recipe_ingredients(id,ordinal,source_name,quantity,unit))')
        .order('code')
      if (error) throw error
      return data
    },
  })
  const role = profile.data?.role
  const productForUnits = catalog.data?.find(product => product.id === unitItem)

  return <>
    <header><strong>Sabor Purezza SMART</strong><button className="secondary" onClick={() => void supabase.auth.signOut()}>Sair</button></header>
    <main className="workspace">
      {profile.isPending && <p role="status">Verificando acesso…</p>}
      {profile.isError && <p role="alert">Falha ao consultar o perfil.</p>}
      {profile.isSuccess && !profile.data && <p role="alert">Esta conta precisa de um perfil ativo.</p>}
      {profile.data && <>
        <p className="identity">{profile.data.display_name} · {role}</p>
        <nav aria-label="Gestão">
          <button aria-pressed={tab === 'dashboard'} onClick={() => setTab('dashboard')}>Indicadores</button>
          <button aria-pressed={tab === 'products'} onClick={() => setTab('products')}>Produtos</button>
          {role !== 'VENDAS' && <button aria-pressed={tab === 'recipes'} onClick={() => setTab('recipes')}>Receitas</button>}
          {role === 'ADMINISTRADOR' && <button aria-pressed={tab === 'recipe-assignments'} onClick={() => setTab('recipe-assignments')}>Associações de receitas</button>}
          {role === 'ADMINISTRADOR' && <button aria-pressed={tab === 'import'} onClick={() => setTab('import')}>Importação</button>}
          {role === 'ADMINISTRADOR' && <button aria-pressed={tab === 'operational-catalog'} onClick={() => setTab('operational-catalog')}>Cadastros operacionais</button>}
          {role !== 'VENDAS' && <button aria-pressed={tab === 'inventory'} onClick={() => setTab('inventory')}>Estoque</button>}
          {role !== 'PRODUCAO' && <button aria-pressed={tab === 'customers'} onClick={() => setTab('customers')}>Clientes</button>}
          {role !== 'PRODUCAO' && <button aria-pressed={tab === 'orders'} onClick={() => setTab('orders')}>Pedidos</button>}
          {role !== 'VENDAS' && <button aria-pressed={tab === 'production-demand'} onClick={() => setTab('production-demand')}>Demanda de produção</button>}
          <button aria-pressed={tab === 'production-board'} onClick={() => setTab('production-board')}>Quadro de produção</button>
          <button aria-pressed={tab === 'shipping'} onClick={() => setTab('shipping')}>Expedição</button>
          {role !== 'VENDAS' && <button aria-pressed={tab === 'traceability'} onClick={() => setTab('traceability')}>Rastreabilidade</button>}
          {role !== 'VENDAS' && <button aria-pressed={tab === 'recall'} onClick={() => setTab('recall')}>Recolhimentos</button>}
          {role !== 'VENDAS' && <button aria-pressed={tab === 'losses'} onClick={() => setTab('losses')}>Desperdícios</button>}
        </nav>
        {tab === 'dashboard' && <Suspense fallback={<p role="status">Abrindo indicadores…</p>}><Dashboard key={`${userId}:${role}`} accessKey={`${userId}:${role}`} /></Suspense>}
        {tab === 'products' && <section className="panel"><h1>Produtos</h1>
          {role === 'ADMINISTRADOR' && productForUnits ? <Suspense fallback={<p role="status">Abrindo configuração…</p>}>
            <ProductUnits key={productForUnits.id} product={productForUnits} onClose={() => setUnitItem(null)}/>
          </Suspense> : <>
          {catalog.isPending && <p role="status">Carregando produtos…</p>}
          {catalog.isError && <p role="alert">Falha ao carregar produtos.</p>}
          {catalog.data?.length === 0 && <p>Nenhum produto cadastrado.</p>}
          {!!catalog.data?.length && <div className="table-scroll"><table><thead><tr>
            <th>Código</th><th>Produto</th><th>Classificação</th><th>Validação</th><th>Unidade</th>
            {role === 'ADMINISTRADOR' && <th>Ação</th>}
          </tr></thead><tbody>{catalog.data.map(item => <tr key={item.id}>
            <td>{item.original_code}</td><td>{item.commercial_description ?? item.original_description}</td>
            <td>{item.classification.replaceAll('_', ' ')}</td><td>{item.validation_status.replaceAll('_', ' ')}</td>
            <td>{item.base_unit ?? 'A validar'}</td>
            {role === 'ADMINISTRADOR' && <td><button type="button" className="secondary" onClick={() => setUnitItem(item.id)}>
              Configurar unidade<span className="sr-only"> do item {item.original_code}</span>
            </button></td>}
          </tr>)}</tbody></table></div>}
          </>}
        </section>}
        {tab === 'recipes' && role !== 'VENDAS' && <section className="panel"><h1>Receitas</h1>
          {recipeReview ? <Suspense fallback={<p role="status">Abrindo ficha…</p>}>
            <RecipeReview key={recipeReview.id} versionId={recipeReview.id} title={recipeReview.title}
              canEdit={role === 'ADMINISTRADOR'} canApprove={profile.data.can_approve_recipe} onClose={() => setRecipeReview(null)}/>
          </Suspense> : <>
          {recipes.isPending && <p role="status">Carregando receitas…</p>}
          {recipes.isError && <p role="alert">Falha ao carregar receitas.</p>}
          {recipes.data?.length === 0 && <p>Nenhuma receita cadastrada.</p>}
          {recipes.data?.map(recipe => <article key={recipe.id}>
            <h2>{recipe.code} · {recipe.name}</h2>
            {recipe.recipe_versions.map(version => <details key={version.id}>
              <summary>Versão {version.version} · {version.status === 'APROVADA' ? 'Aprovada' : 'Pendente de validação'}</summary>
              <ul>{[...version.recipe_ingredients].sort((a,b) => a.ordinal - b.ordinal).map(ingredient => <li key={ingredient.id}>
                {ingredient.source_name} · {ingredient.quantity == null ? 'Quantidade a validar' : `${Number(ingredient.quantity).toLocaleString('pt-BR')} ${ingredient.unit}`}
              </li>)}</ul>
              <button className="secondary" type="button" onClick={() => setRecipeReview({
                id: version.id, title: recipe.name + ' · versão ' + version.version,
              })}>Abrir ficha técnica</button>
            </details>)}
          </article>)}
          </>}
        </section>}
        {tab === 'import' && role === 'ADMINISTRADOR' && <Suspense fallback={<p role="status">Abrindo importação…</p>}>
          <ImportForm/>
        </Suspense>}
        {tab === 'recipe-assignments' && role === 'ADMINISTRADOR' && <Suspense fallback={<p role="status">Abrindo associações…</p>}>
          <RecipeAssignments/>
        </Suspense>}
        {tab === 'operational-catalog' && role === 'ADMINISTRADOR' && <Suspense fallback={<p role="status">Abrindo cadastros…</p>}>
          <OperationalCatalogs/>
        </Suspense>}
        {tab === 'inventory' && role !== 'VENDAS' && <Suspense fallback={<p role="status">Abrindo estoque…</p>}>
          <Inventory admin={role === 'ADMINISTRADOR'} release={profile.data.can_release_lot}/>
        </Suspense>}
        {tab === 'customers' && role !== 'PRODUCAO' && <Suspense fallback={<p role="status">Abrindo cadastro…</p>}>
          <Customers/>
        </Suspense>}
        {tab === 'orders' && role !== 'PRODUCAO' && <Suspense fallback={<p role="status">Abrindo pedidos…</p>}>
          <Orders canRegisterBilling={role === 'VENDAS'}/>
        </Suspense>}
        {tab === 'production-demand' && role !== 'VENDAS' && <Suspense fallback={<p role="status">Abrindo demandas…</p>}>
          <ProductionDemand/>
        </Suspense>}
        {tab === 'shipping' && <Suspense fallback={<p role="status">Abrindo expedição…</p>}>
          <Shipping allowOperations={role !== 'VENDAS'}/>
        </Suspense>}
        {tab === 'production-board' && <Suspense fallback={<p role="status">Abrindo quadro…</p>}>
          <ProductionBoard canStart={role !== 'VENDAS'}/>
        </Suspense>}
        {tab === 'traceability' && role !== 'VENDAS' && <Suspense fallback={<p role="status">Abrindo rastreabilidade…</p>}>
          <Traceability/>
        </Suspense>}
        {tab === 'recall' && role !== 'VENDAS' && <Suspense fallback={<p role="status">Abrindo recolhimentos…</p>}>
          <Recall canOpen={role === 'ADMINISTRADOR'} canResolve={role === 'ADMINISTRADOR' && profile.data.can_release_lot}/>
        </Suspense>}
        {tab === 'losses' && role !== 'VENDAS' && <Suspense fallback={<p role="status">Abrindo desperdícios…</p>}>
          <Losses admin={role === 'ADMINISTRADOR'} canAuthorize={profile.data.can_release_lot}/>
        </Suspense>}
      </>}
    </main>
  </>
}

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [recovery, setRecovery] = useState(false)
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true)
      if (event === 'SIGNED_OUT') {
        setRecovery(false)
        cache.clear()
      }
      setSession(nextSession)
    })
    return () => data.subscription.unsubscribe()
  }, [])
  if (session === undefined) return <main className="workspace" role="status">Abrindo sessão…</main>
  if (recovery || !session) return <Access recovery={recovery}/>
  return <Workspace key={session.user.id} userId={session.user.id}/>
}

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={cache}><App/></QueryClientProvider>)
