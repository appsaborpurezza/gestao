import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, PackageSearch } from 'lucide-react'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { Badge, EmptyState, ErrorState, PageHeader, Skeleton, StatCard } from '../../ui'
import { DataTable, type Column } from '../../ui/DataTable'
import { Tabs } from '../../ui/Tabs'
import { lotStatusLabels, lotStatusTones, type LotStatus } from './lotStatus'
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

const originLabels: Record<Lot['origin'], string> = {
  RECEBIMENTO: 'Recebimento', INVENTARIO_INICIAL: 'Inventário inicial', PRODUCAO: 'Produção', DEVOLUCAO: 'Devolução',
}
const StatusBadge = ({ value }: { value: string }) =>
  <Badge tone={lotStatusTones[value as LotStatus] ?? 'neutral'}>{lotStatusLabels[value as LotStatus] ?? status(value)}</Badge>

function Origin({ lot }: { lot: Lot }) {
  return <article className="ui-detail">
    <div className="ui-detail-header">
      <div>
        <h3 className="ui-code">{lot.code}</h3>
        <p className="ui-muted">Lote original {lot.original_lot}</p>
      </div>
      <span className="ui-cell-stack"><Badge tone="info">{originLabels[lot.origin]}</Badge><StatusBadge value={lot.status}/></span>
    </div>
    <dl>
      <div><dt>Fabricante</dt><dd>{lot.manufacturer}</dd></div>
      <div><dt>Fabricação</dt><dd>{date(lot.manufactured_on)}</dd></div>
      <div><dt>Validade</dt><dd>{lot.expiry === 'NAO_APLICAVEL' ? 'Não aplicável' : date(lot.expires_on)}</dd></div>
      {lot.origin === 'RECEBIMENTO' && <>
        <div><dt>Recebimento</dt><dd>{stamp(lot.received_at)}</dd></div>
        <div><dt>Fornecedor</dt><dd>{lot.supplier ?? 'Não informado'}</dd></div>
        <div><dt>Nota fiscal</dt><dd>{lot.invoice_number ?? 'Não informada'}</dd></div>
      </>}
      {lot.origin === 'INVENTARIO_INICIAL' && <>
        <div><dt>Abertura</dt><dd>{stamp(lot.opened_at)} · {lot.opened_by}</dd></div>
        <div><dt>Local</dt><dd>{lot.opening_location}</dd></div>
        <div><dt>Referência</dt><dd>{lot.opening_reference} · Documento {lot.opening_invoice ?? 'não informado'}</dd></div>
      </>}
      {lot.origin === 'DEVOLUCAO' && <>
        <div><dt>Lote despachado</dt><dd className="ui-code">{lot.parent_code}</dd></div>
        <div><dt>Motivo</dt><dd>{lot.return_reason ?? 'Não informado'}</dd></div>
      </>}
      {lot.origin === 'PRODUCAO' && <>
        <div><dt>OP</dt><dd>{lot.production_number}</dd></div>
        <div><dt>Massada</dt><dd className="ui-code">{lot.production_code}</dd></div>
      </>}
    </dl>
    {lot.origin === 'RECEBIMENTO' && lot.documentation_reason && <p className="ui-muted">{lot.documentation_reason}</p>}
  </article>
}

type View = 'origin' | 'production' | 'balances' | 'destinations' | 'movements' | 'decisions'
type Balance = Trace['balances'][number]
type Destination = Trace['destinations'][number]
type Movement = Trace['movements'][number]
type Decision = Trace['decisions'][number]
const lotCell = (code: string, location: string) =>
  <span className="ui-cell-stack"><span className="ui-code">{code}</span><span>{location}</span></span>
const balanceColumns: Column<Balance>[] = [
  { id: 'lot', header: 'Lote', cell: row => <span className="ui-code">{row.code}</span>, sortValue: row => row.code },
  { id: 'location', header: 'Local', cell: row => row.location, sortValue: row => row.location },
  { id: 'physical', header: 'Físico', align: 'end', cell: row => <strong>{formatStockQuantity(row.physical)} {row.unit}</strong>, sortValue: row => Number(row.physical) },
  { id: 'reserved', header: 'Reservado', align: 'end', cell: row => formatStockQuantity(row.reserved) + ' ' + row.unit, sortValue: row => Number(row.reserved) },
]
const destinationColumns: Column<Destination>[] = [
  { id: 'order', header: 'Pedido e cliente', cell: row => <span className="ui-cell-stack"><strong>Pedido {row.order_number}</strong><span>{row.customer_name}</span></span>, sortValue: row => row.customer_name },
  { id: 'lot', header: 'Lote e local', cell: row => lotCell(row.code, row.location) },
  { id: 'quantity', header: 'Quantidade', align: 'end', cell: row => formatStockQuantity(row.quantity) + ' ' + row.unit },
  { id: 'dispatched', header: 'Despacho', cell: row => <span className="ui-cell-stack"><span>{stamp(row.dispatched_at)}</span><span>{row.operator} · {status(row.method)}</span></span>, sortValue: row => row.dispatched_at },
  { id: 'delivered', header: 'Recebimento', cell: row => row.delivered_at ? stamp(row.delivered_at) : <Badge tone="warning">Pendente</Badge> },
]
const movementColumns: Column<Movement>[] = [
  { id: 'when', header: 'Horário e operador', cell: row => <span className="ui-cell-stack"><span>{stamp(row.created_at)}</span><span>{row.operator}</span></span>, sortValue: row => row.created_at },
  { id: 'lot', header: 'Lote e local', cell: row => lotCell(row.code, row.location) },
  { id: 'kind', header: 'Movimento', cell: row => status(row.kind), sortValue: row => row.kind },
  { id: 'delta', header: 'Variação', align: 'end', cell: row => <strong data-tone={Number(row.delta) < 0 ? 'danger' : 'success'}>
    {Number(row.delta) > 0 ? '+' : ''}{formatStockQuantity(row.delta)} {row.unit}</strong>, sortValue: row => Number(row.delta) },
]
const decisionColumns: Column<Decision>[] = [
  { id: 'when', header: 'Horário e responsável', cell: row => <span className="ui-cell-stack"><span>{stamp(row.created_at)}</span><span>{row.operator}</span></span>, sortValue: row => row.created_at },
  { id: 'lot', header: 'Lote', cell: row => <span className="ui-code">{row.code}</span> },
  { id: 'change', header: 'Mudança', cell: row => <span className="ui-trace-change"><StatusBadge value={row.old_status}/><ArrowRight aria-label="para" size={14}/><StatusBadge value={row.new_status}/></span> },
  { id: 'reason', header: 'Justificativa', cell: row => row.reason },
]

export function Traceability({ initialCode }: { initialCode?: string }) {
  const [code, setCode] = useState<string | null>(initialCode ?? null)
  const [view, setView] = useState<View>('origin')
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
    else { setCode(next); setView('origin') }
    panel.current?.scrollIntoView({ block: 'start' })
  }

  const physical = report?.balances.reduce((sum, row) => sum + Number(row.physical), 0) ?? 0
  const unit = report?.balances[0]?.unit ?? report?.lots[0]?.unit ?? ''
  const customers = new Set(report?.destinations.map(row => row.customer_name)).size
  const batches = report?.production?.batches?.length ?? 0

  return <section className="panel" ref={panel}>
    <PageHeader icon={PackageSearch} title="Rastreabilidade"
      description="Origem, produção, saldos, destinos e decisões sanitárias de um lote, a partir do código interno ou do QR da etiqueta."/>
    <LotScanner onFind={find}/>
    {!code && <EmptyState icon={PackageSearch} title="Consulte um lote"
      description="Digite o código interno ou leia o QR da etiqueta para ver a cadeia completa do lote."/>}
    {code && query.isFetching && !report && <Skeleton lines={6} label="Consultando a origem e os destinos…"/>}
    {query.isError && <ErrorState title="Falha ao consultar a rastreabilidade" onRetry={() => void query.refetch()}/>}
    {query.isSuccess && !report && <EmptyState title="Nenhum lote encontrado" description={<>Confira o código <span className="ui-code">{code}</span> e tente novamente.</>}/>}
    {report && <>
      <div className="ui-trace-summary">
        <h2>{report.item.code} · {report.item.description}</h2>
        <p className="ui-muted">Lote consultado <span className="ui-code">{report.selected_code}</span>
          {report.root_code !== report.selected_code && <> · lote de origem <span className="ui-code">{report.root_code}</span></>}</p>
      </div>
      <div className="ui-stat-grid">
        <StatCard label="Lotes relacionados" value={report.lots.length}/>
        <StatCard label="Saldo físico atual" value={formatStockQuantity(String(physical))} unit={unit}
          context={report.balances.length + (report.balances.length === 1 ? ' local' : ' locais')}/>
        <StatCard label="Massadas" value={batches}/>
        <StatCard label="Despachos" value={report.destinations.length} context={customers + (customers === 1 ? ' cliente' : ' clientes')}
          tone={report.destinations.length ? 'info' : 'neutral'}/>
      </div>
      <Tabs label="Seções da rastreabilidade" value={view} onChange={setView} items={[
        { id: 'origin', label: `Origem (${report.lots.length})` },
        { id: 'production', label: 'Produção' },
        { id: 'balances', label: `Saldos (${report.balances.length})` },
        { id: 'destinations', label: `Destinos (${report.destinations.length})` },
        { id: 'movements', label: `Movimentações (${report.movements.length})` },
        { id: 'decisions', label: `Decisões (${report.decisions.length})` },
      ]}/>
      {view === 'origin' && <div className="ui-trace-origins">{report.lots.map(lot => <Origin key={lot.code} lot={lot}/>)}</div>}
      {view === 'production' && <ProductionGenealogy data={report.production} onFind={find}/>}
      {view === 'balances' && <DataTable caption="Saldo atual por local" rows={report.balances} columns={balanceColumns}
        rowKey={row => row.code + '/' + row.location} empty={{ title: 'Nenhum saldo registrado' }}/>}
      {view === 'destinations' && <DataTable caption="Destinos e entregas" rows={report.destinations} columns={destinationColumns}
        rowKey={row => row.id} empty={{ title: 'Nenhum despacho registrado para estes lotes' }}/>}
      {view === 'movements' && <DataTable caption="Movimentações" rows={report.movements} columns={movementColumns}
        rowKey={row => row.id} empty={{ title: 'Nenhuma movimentação registrada' }}/>}
      {view === 'decisions' && <DataTable caption="Decisões sanitárias" rows={report.decisions} columns={decisionColumns}
        rowKey={row => row.id} empty={{ title: 'Nenhuma decisão registrada' }}/>}
    </>}
  </section>
}
