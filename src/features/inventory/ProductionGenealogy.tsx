import { formatStockQuantity } from '../../lib/decimal'
import { Badge, EmptyState } from '../../ui'
import { DataTable, type Column } from '../../ui/DataTable'

type Batch = {
  id: string; batch_code: string; sequence: number; status: string; production_number: string
  recipe_name: string; recipe_version: number; item_code: string; product: string
  output_code: string | null; output_status: string | null; output_units: string | null
  nominal_kg: string | null; actual_kg: string | null; finished_at: string | null; finished_by: string | null
}
type Link = {
  batch_id: string; movement_id: string; stage: string; material: string; kind: string; quantity: string
  source_code: string; source_original_lot: string; expires_on: string | null; unit: string; location: string
  manufacturer: string; supplier: string | null; invoice_number: string | null; opening_reference: string | null
  opening_invoice: string | null; consumed_at: string; operator: string
}
export type Genealogy = {
  batches: Batch[]; inputs: Link[]; uses: Link[]
  losses: { id: string; batch_id: string; operation: string; quantity: string; reason: string
    destination: string; occurred_at: string; operator: string }[]
  water: { id: string; batch_id: string; stage: string; source: string; control_reference: string
    quantity: string; unit: string; recorded_at: string; operator: string }[]
  destinations: { id: string; batch_id: string; output_code: string; order_number: string; customer_name: string
    quantity: string; unit: string; dispatched_at: string; delivered_at: string | null; operator: string }[]
}
const local = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short',
})
const stamp = (value: string) => local.format(new Date(value))
const amount = (value: string, unit: string) => formatStockQuantity(value) + ' ' + unit
const readable = (value: string) => value.replaceAll('_', ' ')

function LotLink({ code, onFind }: { code: string; onFind: (code: string) => void }) {
  return <button className="ui-link-button ui-code" type="button" onClick={() => onFind(code)} aria-label={'Consultar lote ' + code}>
    {code}
  </button>
}

export function ProductionGenealogy({ data, onFind }: { data: Genealogy; onFind: (code: string) => void }) {
  const batchCodes = new Map(data.batches.map(batch => [batch.id, batch.batch_code]))
  const batchCell = (id: string, stage: string) =>
    <span className="ui-cell-stack"><span className="ui-code">{batchCodes.get(id)}</span><span>{readable(stage)}</span></span>
  const inputColumns: Column<Link>[] = [
    { id: 'batch', header: 'Massada e etapa', cell: row => batchCell(row.batch_id, row.stage) },
    { id: 'material', header: 'Insumo e lote', cell: row => <span className="ui-cell-stack">
      <strong>{row.material}</strong><LotLink code={row.source_code} onFind={onFind}/>
      <span>Lote original {row.source_original_lot} · {row.location}</span></span> },
    { id: 'origin', header: 'Origem', cell: row => <span className="ui-cell-stack">
      <span>{row.manufacturer}{row.supplier && ' · ' + row.supplier}</span>
      <span>{row.invoice_number ? 'NF ' + row.invoice_number : row.opening_invoice ?? row.opening_reference ?? 'Documento não informado'}</span>
      {row.expires_on && <span>Validade {row.expires_on.split('-').reverse().join('/')}</span>}</span> },
    { id: 'consumed', header: 'Consumo', align: 'end', cell: row => <span className="ui-cell-stack">
      <strong>{amount(row.quantity, row.unit)}</strong><span>{stamp(row.consumed_at)} · {row.operator}</span></span> },
  ]
  const useColumns: Column<Link>[] = [
    { id: 'lot', header: 'Lote consultado', cell: row => <span className="ui-code">{row.source_code}</span> },
    { id: 'batch', header: 'Massada e etapa', cell: row => batchCell(row.batch_id, row.stage) },
    { id: 'material', header: 'Insumo', cell: row => row.material },
    { id: 'consumed', header: 'Consumo', align: 'end', cell: row => <span className="ui-cell-stack">
      <strong>{amount(row.quantity, row.unit)}</strong><span>{stamp(row.consumed_at)} · {row.operator}</span></span> },
  ]
  const destinationColumns: Column<Genealogy['destinations'][number]>[] = [
    { id: 'order', header: 'Pedido e cliente', cell: row => <span className="ui-cell-stack"><strong>Pedido {row.order_number}</strong><span>{row.customer_name}</span></span> },
    { id: 'lot', header: 'Lote acabado', cell: row => <LotLink code={row.output_code} onFind={onFind}/> },
    { id: 'quantity', header: 'Quantidade', align: 'end', cell: row => amount(row.quantity, row.unit) },
    { id: 'dispatched', header: 'Despacho', cell: row => <span className="ui-cell-stack"><span>{stamp(row.dispatched_at)}</span><span>{row.operator}</span></span> },
    { id: 'delivered', header: 'Recebimento', cell: row => row.delivered_at ? stamp(row.delivered_at) : <Badge tone="warning">Pendente</Badge> },
  ]

  return <section className="ui-genealogy" aria-label="Fabricação própria">
    {data.batches.length === 0 && <EmptyState title="Nenhuma massada vinculada" description="Estes lotes não participaram de produção própria."/>}
    {data.batches.map(batch => <article key={batch.id} className="ui-detail">
      <div className="ui-detail-header">
        <div>
          <h3>OP {batch.production_number} · <span className="ui-code">{batch.batch_code}</span></h3>
          <p className="ui-muted">{batch.item_code} · {batch.product} · {batch.recipe_name}, versão {batch.recipe_version}</p>
        </div>
        <Badge tone={batch.status === 'FINALIZADA' ? 'success' : 'info'}>{readable(batch.status)}</Badge>
      </div>
      {batch.output_code ? <dl>
        <div><dt>Lote acabado</dt><dd><LotLink code={batch.output_code} onFind={onFind}/></dd></div>
        {batch.output_status && <div><dt>Situação do acabado</dt><dd>{readable(batch.output_status)}</dd></div>}
        {batch.output_units && <div><dt>Unidades</dt><dd>{amount(batch.output_units, 'un')}</dd></div>}
        {batch.nominal_kg && <div><dt>Nominal</dt><dd>{amount(batch.nominal_kg, 'kg')}</dd></div>}
        {batch.actual_kg && <div><dt>Medido</dt><dd>{amount(batch.actual_kg, 'kg')}</dd></div>}
        {batch.finished_at && <div><dt>Finalizado</dt><dd>{stamp(batch.finished_at)} · {batch.finished_by}</dd></div>}
      </dl> : <p className="ui-muted">Acabado ainda não registrado.</p>}
    </article>)}
    {data.inputs.length > 0 && <>
      <h3>Lotes usados para fabricar o acabado</h3>
      <DataTable caption="Lotes usados para fabricar o acabado" rows={data.inputs} columns={inputColumns} rowKey={row => row.movement_id}/>
    </>}
    {data.uses.length > 0 && <>
      <h3>Onde o lote consultado foi usado</h3>
      <DataTable caption="Onde o lote consultado foi usado" rows={data.uses} columns={useColumns} rowKey={row => row.movement_id}/>
    </>}
    {data.water.length > 0 && <>
      <h3>Água de processo</h3>
      <ul className="ui-plain-list">{data.water.map(row => <li key={row.id}>
        <span className="ui-code">{batchCodes.get(row.batch_id)}</span> · {amount(row.quantity, row.unit)} · {row.source}
        {' · '}Controle {row.control_reference} · {stamp(row.recorded_at)} · {row.operator}
      </li>)}</ul>
    </>}
    {data.losses.length > 0 && <>
      <h3>Perdas de massa registradas</h3>
      <ul className="ui-plain-list">{data.losses.map(row => <li key={row.id}>
        <span className="ui-code">{batchCodes.get(row.batch_id)}</span> · {readable(row.operation)} · <strong>{amount(row.quantity, 'kg')}</strong>
        {' · '}{row.reason} · {row.destination} · {stamp(row.occurred_at)} · {row.operator}
      </li>)}</ul>
    </>}
    {data.destinations.length > 0 && <>
      <h3>Destinos dos acabados vinculados</h3>
      <DataTable caption="Destinos dos acabados vinculados" rows={data.destinations} columns={destinationColumns} rowKey={row => row.id}/>
    </>}
  </section>
}
