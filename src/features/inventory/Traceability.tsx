import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { LotScanner } from './LotScanner'
import { ProductionGenealogy, type Genealogy } from './ProductionGenealogy'

type Lot = {
  code: string; original_lot: string; status: string; unit: string; expiry: string
  manufactured_on: string | null; expires_on: string | null; manufacturer: string; supplier: string | null
  invoice_number: string | null; documentation_reason: string | null; received_at: string | null
  opening_reference: string | null; opening_invoice: string | null; opened_at: string | null
  opening_location: string | null; opened_by: string | null
  return_reason: string | null; parent_code: string | null
  production_code: string | null; production_number: string | null
  origin: 'DEVOLUCAO' | 'RECEBIMENTO' | 'INVENTARIO_INICIAL' | 'PRODUCAO'
}
type Trace = {
  production: Genealogy
  selected_code: string; root_code: string; item: { code: string; description: string }; lots: Lot[]
  balances: { code: string; unit: string; location: string; physical: string; reserved: string }[]
  movements: { id: string; code: string; unit: string; location: string; kind: string; delta: string; created_at: string; operator: string }[]
  decisions: { id: string; code: string; old_status: string; new_status: string; reason: string; created_at: string; operator: string }[]
  destinations: { id: string; code: string; unit: string; location: string; order_number: string; customer_name: string
    method: string; quantity: string; dispatched_at: string; delivered_at: string | null; operator: string }[]
}
const date = (value: string | null) => value?.split('-').reverse().join('/') ?? 'Não informada'
const local = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short',
})
const stamp = (value: string | null) => value ? local.format(new Date(value)) : 'Pendente'
const status = (value: string) => value.replaceAll('_', ' ')

function Origin({ lot }: { lot: Lot }) {
  return <article>
    <h3 className="break-code">{lot.code}</h3>
    <p>{status(lot.origin)} · {lot.status} · Lote original {lot.original_lot}</p>
    <p>Fabricante {lot.manufacturer} · Fabricação {date(lot.manufactured_on)} · Validade {
      lot.expiry === 'NAO_APLICAVEL' ? 'Não aplicável' : date(lot.expires_on)
    }</p>
    {lot.origin === 'RECEBIMENTO' && <p>Recebimento {stamp(lot.received_at)} · Fornecedor {lot.supplier ?? 'Não informado'}
      {' · '}NF {lot.invoice_number ?? 'Não informada'}{lot.documentation_reason && ' · ' + lot.documentation_reason}</p>}
    {lot.origin === 'INVENTARIO_INICIAL' && <p>Abertura {stamp(lot.opened_at)} · {lot.opening_location} · {lot.opened_by}
      {' · '}Referência {lot.opening_reference} · Documento {lot.opening_invoice ?? 'Não informado'}</p>}
    {lot.origin === 'DEVOLUCAO' && <p className="break-code">Lote despachado {lot.parent_code} · Motivo {lot.return_reason ?? 'Não informado'}</p>}
    {lot.origin === 'PRODUCAO' && <p>OP {lot.production_number} · Massada {lot.production_code}</p>}
  </article>
}

export function Traceability({ initialCode }: { initialCode?: string }) {
  const [code, setCode] = useState<string | null>(initialCode ?? null)
  const panel = useRef<HTMLElement>(null)
  const query = useQuery({
    queryKey: ['inventory', 'trace', code],
    enabled: code !== null,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.rpc('trace_inventory_lot', { internal_code: code }).abortSignal(signal)
      if (error) throw error
      return data as Trace | null
    },
  })
  const report = query.data

  function find(next: string) {
    if (next === code) void query.refetch()
    else setCode(next)
    panel.current?.scrollIntoView({ block: 'start' })
  }

  return <section className="panel" ref={panel}>
    <h1>Rastreabilidade</h1>
    <LotScanner onFind={find}/>
    {code && query.isFetching && <p role="status">Consultando a origem e os destinos…</p>}
    {query.isError && <p role="alert">Falha ao consultar a rastreabilidade.</p>}
    {query.isSuccess && !report && <p>Nenhum lote encontrado para este código.</p>}
    {report && <>
      <h2>{report.item.code} · {report.item.description}</h2>
      <p className="break-code">Lote consultado {report.selected_code} · Lote de origem {report.root_code}</p>
      <section>
        <h3>Origem e lotes relacionados</h3>
        {report.lots.map(lot => <Origin key={lot.code} lot={lot}/>)}
      </section>
      <ProductionGenealogy data={report.production} onFind={find}/>
      <section>
        <h3>Saldo atual por local</h3>
        {report.balances.length === 0 ? <p>Nenhum saldo registrado.</p> : <div className="table-scroll"><table>
          <thead><tr><th>Lote</th><th>Local</th><th>Físico</th><th>Reservado</th></tr></thead>
          <tbody>{report.balances.map(row => <tr key={row.code + '/' + row.location}>
            <td>{row.code}</td><td>{row.location}</td><td>{formatStockQuantity(row.physical)} {row.unit}</td>
            <td>{formatStockQuantity(row.reserved)} {row.unit}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
      <section>
        <h3>Destinos e entregas</h3>
        {report.destinations.length === 0 ? <p>Nenhum despacho registrado para estes lotes.</p> : <div className="table-scroll"><table>
          <thead><tr><th>Pedido e cliente</th><th>Lote e local</th><th>Quantidade</th><th>Despacho</th><th>Recebimento</th></tr></thead>
          <tbody>{report.destinations.map(row => <tr key={row.id}>
            <td>{row.order_number} · {row.customer_name}</td><td>{row.code} · {row.location}</td>
            <td>{formatStockQuantity(row.quantity)} {row.unit}</td>
            <td>{stamp(row.dispatched_at)} · {row.operator} · {row.method}</td><td>{stamp(row.delivered_at)}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
      <section>
        <h3>Movimentações</h3>
        {report.movements.length === 0 ? <p>Nenhuma movimentação registrada.</p> : <div className="table-scroll"><table>
          <thead><tr><th>Horário e operador</th><th>Lote e local</th><th>Movimento</th><th>Variação</th></tr></thead>
          <tbody>{report.movements.map(row => <tr key={row.id}>
            <td>{stamp(row.created_at)} · {row.operator}</td><td>{row.code} · {row.location}</td>
            <td>{status(row.kind)}</td><td>{formatStockQuantity(row.delta)} {row.unit}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
      <section>
        <h3>Decisões sanitárias</h3>
        {report.decisions.length === 0 ? <p>Nenhuma decisão registrada.</p> : <ul>{report.decisions.map(row => <li key={row.id} className="break-code">
          {stamp(row.created_at)} · {row.code} · {row.old_status} → {row.new_status} · {row.operator} · {row.reason}
        </li>)}</ul>}
      </section>
    </>}
  </section>
}
