import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { AppShell } from './layouts/AppShell'
import type { RecordMatch } from './layouts/RecordSearch'
import { Access } from './features/auth/Access'
import { supabase } from './lib/supabase'
import { formatRoute, useHashRoute } from './lib/routes'
import { canNavigate } from './layouts/navigation'
import { ErrorState, ForbiddenState, Skeleton } from './ui'
import { Toaster } from './ui/toast'
import { QuickActions } from './ui/QuickActions'
import type { QuickAction } from './lib/workspace'
import { RecipeList } from './features/recipes/RecipeList'
import { ProductCatalog } from './features/products/ProductCatalog'
import './styles/tokens.css'
import './styles.css'
import './styles/shell.css'

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
  const [route, navigate] = useHashRoute()
  const tab = route.module
  const setTab = (module: string) => navigate({ module, recordId: null })
  const [targetMeta, setTargetMeta] = useState<RecordMatch | null>(null)
  // O registro aberto vem da URL; o rótulo da busca só complementa a exibição.
  const target = useMemo<RecordMatch | null>(() => route.recordId
    ? (targetMeta?.record_id === route.recordId && targetMeta.module === route.module
      ? targetMeta : { module: route.module as RecordMatch['module'], record_id: route.recordId, label: '', reference: '' })
    : null, [route, targetMeta])
  const setTarget = (record: RecordMatch | null) => {
    setTargetMeta(record)
    navigate(record ? { module: record.module, recordId: record.record_id } : { module: route.module, recordId: null })
  }
  // Ações rápidas (ex.: #/orders/novo) abrem o formulário uma vez; o endereço volta ao módulo
  // para que atualizar a página não reabra o formulário. O contador remonta a tela a cada pedido.
  const [actionRun, setActionRun] = useState(0)
  const action = route.action
  const actionKey = action ? `${action}:${actionRun}` : 'list'
  useEffect(() => {
    if (route.action) history.replaceState(null, '', formatRoute({ module: route.module, recordId: null }))
  }, [route])
  const runQuick = (quick: QuickAction) => {
    setTargetMeta(null)
    setActionRun(value => value + 1)
    navigate({ module: quick.module, recordId: null, action: quick.action })
  }
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
        .select('id,original_code,original_description,commercial_description,classification,validation_status,base_unit,unit_version,active,catalog_version')
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
    onNavigate={id => { setTargetMeta(null); setTab(id) }}
    onAction={runQuick}
    onOpenRecord={record => {
      setUnitItem(null)
      setRecipeReview(null)
      setTarget(record)
    }}
    onSignOut={async () => {
      const { error } = await supabase.auth.signOut()
      if (error) throw error
    }}>
      {profile.isPending && <Skeleton lines={4} label="Verificando acesso…"/>}
      {profile.isError && <ErrorState title="Falha ao consultar o perfil" onRetry={() => void profile.refetch()}/>}
      {profile.isSuccess && !profile.data && <ForbiddenState description="Esta conta precisa de um perfil ativo. Procure a administração."/>}
      {role && !canNavigate(tab, role) && <ForbiddenState description="Este endereço não existe ou não está disponível para o seu perfil."/>}
      {profile.data && <>
        {tab === 'dashboard' && <Suspense fallback={<p role="status">Abrindo indicadores…</p>}><Dashboard key={`${userId}:${role}`} accessKey={`${userId}:${role}`} onNavigate={setTab}
          quickActions={role && <QuickActions role={role} onAction={runQuick}/>}/></Suspense>}
        {tab === 'alerts' && <Suspense fallback={<p role="status">Abrindo alertas…</p>}>
          <OperationalAlerts accountScope={`${userId}:${role}`} onNavigate={setTab}/>
        </Suspense>}
        {tab === 'reports' && role && <Suspense fallback={<p role="status">Abrindo relatórios…</p>}>
          <ReportCenter role={role} accountScope={`${userId}:${role}`} onNavigate={setTab}/>
        </Suspense>}
        {tab === 'profiles' && role === 'ADMINISTRADOR' && <Suspense fallback={<p role="status">Abrindo usuários…</p>}>
          <ProfileManagement userId={userId}/>
        </Suspense>}
        {tab === 'products' && <section>
          {role === 'ADMINISTRADOR' && productForUnits ? <Suspense fallback={<Skeleton lines={4} label="Abrindo configuração…"/>}>
            <ProductUnits key={productForUnits.id} product={productForUnits} onClose={() => setUnitItem(null)}/>
          </Suspense> : <ProductCatalog key={actionKey} startNew={action === 'novo'} items={catalog.data} loading={catalog.isFetching} error={catalog.isError}
            onRetry={() => void catalog.refetch()} canConfigure={role === 'ADMINISTRADOR'} onConfigure={setUnitItem}
            focused={target?.module === 'products'} onShowAll={() => { setUnitItem(null); setTarget(null) }}/>}
        </section>}
        {tab === 'recipes' && role !== 'VENDAS' && (recipeReview ? <section className="panel">
          <Suspense fallback={<Skeleton lines={4} label="Abrindo ficha…"/>}>
            <RecipeReview key={recipeReview.id} versionId={recipeReview.id} title={recipeReview.title}
              canEdit={role === 'ADMINISTRADOR'} canApprove={profile.data.can_approve_recipe} onClose={() => setRecipeReview(null)}/>
          </Suspense>
        </section> : <RecipeList recipes={recipes.data} loading={recipes.isFetching} error={recipes.isError}
          onRetry={() => void recipes.refetch()} focused={target?.module === 'recipes'}
          onShowAll={() => { setRecipeReview(null); setTarget(null) }} onOpen={setRecipeReview}/>)}
        {tab === 'import' && role === 'ADMINISTRADOR' && <Suspense fallback={<p role="status">Abrindo importação…</p>}>
          <ImportForm/>
        </Suspense>}
        {tab === 'recipe-assignments' && role === 'ADMINISTRADOR' && <Suspense fallback={<p role="status">Abrindo associações…</p>}>
          <RecipeAssignments/>
        </Suspense>}
        {tab === 'operational-catalog' && role === 'ADMINISTRADOR' && <Suspense fallback={<p role="status">Abrindo cadastros…</p>}>
          <OperationalCatalogs key={actionKey} startNew={action === 'novo'}/>
        </Suspense>}
        {tab === 'inventory' && role !== 'VENDAS' && <Suspense fallback={<p role="status">Abrindo estoque…</p>}>
          <Inventory key={actionKey} startReceive={action === 'receber'} admin={role === 'ADMINISTRADOR'} release={profile.data.can_release_lot}
            initialLot={target?.record_id} onOpen={id => navigate({ module: 'inventory', recordId: id })}/>
        </Suspense>}
        {tab === 'customers' && role !== 'PRODUCAO' && <Suspense fallback={<p role="status">Abrindo cadastro…</p>}>
          <Customers key={target?.record_id ?? 'customers:' + actionKey} startNew={action === 'novo'} initialCustomer={target?.record_id} admin={role === 'ADMINISTRADOR'}
            onOpen={id => navigate({ module: 'customers', recordId: id })}/>
        </Suspense>}
        {tab === 'orders' && role !== 'PRODUCAO' && <Suspense fallback={<p role="status">Abrindo pedidos…</p>}>
          <Orders key={target?.record_id ?? 'orders:' + actionKey} startNew={action === 'novo'} initialOrder={target?.record_id} canRegisterBilling={role === 'VENDAS'}
            onOpen={id => navigate({ module: 'orders', recordId: id })}/>
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
          <Traceability key={target?.module === 'traceability' ? target.record_id : 'traceability'}
            initialCode={target?.module === 'traceability' ? target.reference : undefined}/>
        </Suspense>}
        {tab === 'recall' && role !== 'VENDAS' && <Suspense fallback={<p role="status">Abrindo recolhimentos…</p>}>
          <Recall canOpen={role === 'ADMINISTRADOR'} canResolve={role === 'ADMINISTRADOR' && profile.data.can_release_lot}/>
        </Suspense>}
        {tab === 'losses' && role !== 'VENDAS' && <Suspense fallback={<p role="status">Abrindo desperdícios…</p>}>
          <Losses key={actionKey} startRegister={action === 'registrar'} admin={role === 'ADMINISTRADOR'} canAuthorize={profile.data.can_release_lot}/>
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

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={cache}><App/><Toaster/></QueryClientProvider>)
