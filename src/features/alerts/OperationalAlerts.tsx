import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { Bell, CheckCircle2, RefreshCw } from 'lucide-react'
import { EmptyState, ErrorState, PageHeader, Skeleton, StatCard } from '../../ui'

const definitions = {
  ORDERS_OVERDUE: ['Pedidos atrasados', 'orders', 'Abrir pedidos'],
  ORDERS_DUE_SOON: ['Pedidos com entrega nos próximos três dias', 'orders', 'Abrir pedidos'],
  LOTS_EXPIRED: ['Lotes vencidos ou com vencimento hoje', 'inventory', 'Abrir estoque'],
  LOTS_EXPIRING: ['Lotes liberados com vencimento nos próximos sete dias', 'inventory', 'Abrir estoque'],
  LOTS_QUARANTINE: ['Lotes em quarentena com saldo', 'inventory', 'Abrir estoque'],
  RECALLS_ACTIVE: ['Recolhimentos ativos', 'recall', 'Abrir recolhimentos'],
  INVENTORIES_OPEN: ['Sessões de inventário abertas', 'inventory', 'Abrir estoque'],
  RECIPES_PENDING: ['Versões de receita pendentes de validação', 'recipes', 'Abrir receitas'],
} as const

type Alert = { code: keyof typeof definitions; severity: 'critical' | 'attention'; quantity: number }

export default function OperationalAlerts({ accountScope, onNavigate }: { accountScope: string; onNavigate: (id: string) => void }) {
  const alerts = useQuery({
    queryKey: ['operational-alerts', accountScope],
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.rpc('operational_alerts').abortSignal(signal)
      if (error) throw error
      return data as Alert[]
    },
  })
  const visible = [...(alerts.data ?? [])].sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'))

  return <section className="panel">
    <PageHeader icon={Bell} title="Central de alertas" description="Pendências que precisam de ação, conforme o seu perfil."
      actions={<button className="secondary" type="button" disabled={alerts.isFetching} onClick={() => void alerts.refetch()}>
        <RefreshCw aria-hidden="true" size={16}/>Atualizar alertas</button>}/>
    {alerts.isPending && <Skeleton lines={4} label="Consultando alertas…"/>}
    {alerts.isError && <ErrorState title="Falha ao consultar alertas" onRetry={() => void alerts.refetch()}/>}
    {alerts.isSuccess && !visible.length && <EmptyState icon={CheckCircle2} title="Nenhum alerta no momento"
      description="Não há pendências para o seu perfil."/>}
    {!!visible.length && <div className="ui-stat-grid" role="list" aria-label="Alertas">
      {visible.map(alert => {
        const definition = definitions[alert.code]
        if (!definition) return null
        const [title, destination, action] = definition
        return <div role="listitem" key={alert.code}>
          <StatCard label={title} value={alert.quantity.toLocaleString('pt-BR')}
            tone={alert.severity === 'critical' ? 'danger' : 'warning'}
            context={<>{alert.severity === 'critical' ? 'Crítico' : 'Atenção'} · {action}</>}
            onOpen={() => onNavigate(destination)}/>
        </div>
      })}
    </div>}
  </section>
}
