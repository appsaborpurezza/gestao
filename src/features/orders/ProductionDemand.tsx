import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { PlanSimulation } from './PlanSimulation'

const pageSize = 25

function ResolveWeight({ demandId }: { demandId: string }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<string | null>(null)
  const inFlight = useRef(false)

  async function resolve() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      request.current ??= crypto.randomUUID()
      const { error } = await supabase.rpc('resolve_demand_weight', {
        target_demand: demandId, request_id: request.current,
      })
      if (error) throw new Error(error.message)
      await cache.invalidateQueries({ queryKey: ['orders'] })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao aplicar a conversão.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <>
    <button type="button" className="secondary" disabled={busy} onClick={() => void resolve()}>
      {busy ? 'Aplicando…' : 'Aplicar conversão cadastrada'}
    </button>
    {error && <p role="alert">{error}</p>}
  </>
}

export function ProductionDemand() {
  const [page, setPage] = useState(0)
  const [simulation, setSimulation] = useState<{ id: string; title: string } | null>(null)
  const query = useQuery({
    queryKey: ['orders', 'production-demand', page],
    queryFn: async () => {
      const { data, count, error } = await supabase.from('production_demands')
        .select('order_item_id,order_number,delivery_date,customer_name,item_code,description,unit,quantity::text,requested_kg::text,status,production_orders(production_number)', { count: 'exact' })
        .order('delivery_date').order('order_number').order('order_item_id')
        .range(page * pageSize, (page + 1) * pageSize - 1)
      if (error) throw error
      return { data: data.map(row => ({ ...row, productionOrder: row.production_orders as unknown as
        { production_number: number } | null })), count: count ?? 0 }
    },
  })

  return <section className="panel">
    <h1>Demanda de produção</h1>
    {simulation ? <PlanSimulation demandId={simulation.id} title={simulation.title} onClose={() => setSimulation(null)}/> : <>
    {query.isPending && <p role="status">Carregando demandas…</p>}
    {query.isError && <p role="alert">Falha ao consultar as demandas de produção.</p>}
    {query.data?.data.length === 0 && <p>Nenhuma demanda nesta página.</p>}
    {!!query.data?.data.length && <div className="table-scroll"><table>
      <thead><tr><th>Pedido</th><th>Cliente</th><th>Entrega</th><th>Produto</th><th>Quantidade</th><th>Equivalente em kg</th><th>Status</th><th>Ação</th></tr></thead>
      <tbody>{query.data.data.map(demand => <tr key={demand.order_item_id}>
        <td>{demand.order_number}</td><td>{demand.customer_name}</td>
        <td>{demand.delivery_date.split('-').reverse().join('/')}</td>
        <td>{demand.item_code} · {demand.description}</td>
        <td>{formatStockQuantity(demand.quantity)} {demand.unit}</td>
        <td>{demand.requested_kg === null ? 'A validar' : formatStockQuantity(demand.requested_kg)}</td>
        <td>{demand.productionOrder ? 'OP ' + demand.productionOrder.production_number
          : demand.status === 'PENDENTE_CONVERSAO' ? 'Conversão pendente' : 'Aguardando planejamento'}</td>
        <td>{demand.requested_kg === null ? <ResolveWeight demandId={demand.order_item_id}/> : <button className="secondary" type="button" onClick={() => setSimulation({
          id: demand.order_item_id, title: 'Pedido ' + demand.order_number + ' · ' + demand.description,
        })}>{demand.productionOrder ? 'Abrir planejamento' : 'Simular'}</button>}</td>
      </tr>)}</tbody>
    </table></div>}
    {query.data && (query.data.count > pageSize || page > 0) && <nav aria-label="Páginas de demanda">
      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
      <span>Página {page + 1} · {query.data.count} itens</span>
      <button type="button" disabled={(page + 1) * pageSize >= query.data.count} onClick={() => setPage(page + 1)}>Próxima</button>
    </nav>}
    </>}
  </section>
}
