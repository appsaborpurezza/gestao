import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'

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
    <h1>Central de alertas</h1>
    <button className="secondary" type="button" disabled={alerts.isFetching} onClick={() => void alerts.refetch()}>Atualizar alertas</button>
    {alerts.isPending && <p role="status">Consultando alertas…</p>}
    {alerts.isError && <p role="alert">Falha ao consultar alertas. Tente atualizar.</p>}
    {alerts.isSuccess && !visible.length && <p>Nenhum alerta para o seu perfil no momento.</p>}
    {!!visible.length && <ul className="operational-alerts">
      {visible.map(alert => {
        const definition = definitions[alert.code]
        if (!definition) return null
        const [title, destination, action] = definition
        return <li key={alert.code} data-severity={alert.severity}>
          <span>{alert.severity === 'critical' ? 'Crítico' : 'Atenção'}</span>
          <h2>{title}</h2>
          <strong>{alert.quantity.toLocaleString('pt-BR')}</strong>
          <button type="button" className="secondary" onClick={() => onNavigate(destination)}>{action}</button>
        </li>
      })}
    </ul>}
  </section>
}
