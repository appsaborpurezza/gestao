import { lazy, Suspense, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { AppShell } from './layouts/AppShell'
import type { RecordMatch } from './layouts/RecordSearch'
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
const OperationalAlerts = lazy(() => import('./features/alerts/OperationalAlerts'))
const ReportCenter = lazy(() => import('./features/reports/ReportCenter'))
const ProfileManagement = lazy(() => import('./features/administration/ProfileManagement'))

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })

function Workspace({ userId }: { userId: string }) {
  const [tab, setTab] = useState('dashboard')
  const [target, setTarget] = useState<RecordMatch | null>(null)
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
    queryKey: ['items', userId, target?.module === 'products' ? target.record_id : null],
    enabled: !!profile.data && tab === 'products',
    queryFn: async () => {
      const request = supabase.from('items')
        .select('id,original_code,original_description,commercial_description,classification,validation_status,base_unit,unit_version')
        .order('original_code')
      if (target?.module === 'products') request.eq('id', target.record_id)
      const { data, error } = await request
      if (error) throw error
      return data.sort((a, b) => a.original_code.localeCompare(b.original_code, 'pt-BR', { numeric: true }))
    },
  })
  const recipes = useQuery({
    queryKey: ['recipes', userId, target?.module === 'recipes' ? target.record_id : null],
    enabled: !!profile.data && profile.data.role !== 'VENDAS' && tab === 'recipes',
    queryFn: async () => {
      const request = supabase.from('recipes')
        .select('id,code,name,recipe_versions(id,version,status,yield_min,yield_target,yield_max,recipe_ingredients(id,ordinal,source_name,quantity,unit))')
        .order('code')
      if (target?.module === 'recipes') request.eq('id', target.record_id)
      const { data, error } = await request
      if (error) throw error
      return data
    },
  })
  const role = profile.data?.role
  const productForUnits = catalog.data?.find(product => product.id === unitItem)

  return <AppShell active={tab} role={role} name={profile.data?.display_name} accountScope={`${userId}:${role}`}
    onNavigate={id => { setTarget(null); setTab(id) }}
    onOpenRecord={record => {
      setUnitItem(null)
      setRecipeReview(null)
      setTarget(record)
      setTab(record.module)
    }}
    onSignOut={async () => {
      const { error } = await supabase.auth.signOut()
      if (error) throw error
    }}>
      {profile.isPending && <p role="status">Verificando acesso…</p>}
      {profile.isError && <div role="alert"><p>Falha ao consultar o perfil.</p><button type="button" onClick={() => void profile.refetch()}>Tentar novamente</button></div>}
      {profile.isSuccess && !profile.data && <p role="alert">Esta conta precisa de um perfil ativo.</p>}
      {profile.data && <>
        {tab === 'dashboard' && <Suspense fallback={<p role="status">Abrindo indicadores…</p>}><Dashboard key={`${userId}:${role}`} accessKey={`${userId}:${role}`} /></Suspense>}
        {tab === 'alerts' && <Suspense fallback={<p role="status">Abrindo alertas…</p>}>
          <OperationalAlerts accountScope={`${userId}:${role}`} onNavigate={setTab}/>
        </Suspense>}
        {tab === 'reports' && role && <Suspense fallback={<p role="status">Abrindo relatórios…</p>}>
          <ReportCenter role={role} accountScope={`${userId}:${role}`} onNavigate={setTab}/>
        </Suspense>}
        {tab === 'profiles' && role === 'ADMINISTRADOR' && <Suspense fallback={<p role="status">Abrindo usuários…</p>}>
          <ProfileManagement userId={userId}/>
        </Suspense>}
        {tab === 'products' && <section className="panel"><h1>Produtos</h1>
          {target?.module === 'products' && <button type="button" className="secondary" onClick={() => { setUnitItem(null); setTarget(null) }}>Ver todos os produtos</button>}
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
          {target?.module === 'recipes' && <button type="button" className="secondary" onClick={() => { setRecipeReview(null); setTarget(null) }}>Ver todas as receitas</button>}
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
          <Customers key={target?.record_id ?? 'customers'} initialCustomer={target?.record_id}/>
        </Suspense>}
        {tab === 'orders' && role !== 'PRODUCAO' && <Suspense fallback={<p role="status">Abrindo pedidos…</p>}>
          <Orders key={target?.record_id ?? 'orders'} initialOrder={target?.record_id} canRegisterBilling={role === 'VENDAS'}/>
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
  </AppShell>
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
