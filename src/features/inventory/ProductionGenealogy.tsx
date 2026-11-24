import { formatStockQuantity } from '../../lib/decimal'

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
  return <button className="secondary break-code" type="button" onClick={() => onFind(code)} aria-label={'Consultar lote ' + code}>
    {code}
  </button>
}

export function ProductionGenealogy({ data, onFind }: { data: Genealogy; onFind: (code: string) => void }) {
  const batchCodes = new Map(data.batches.map(batch => [batch.id, batch.batch_code]))
  return <section>
    <h3>Fabricação própria</h3>
    {data.batches.length === 0 && <p>Nenhuma massada vinculada a estes lotes.</p>}
    {data.batches.map(batch => <article key={batch.id}>
      <h4>OP {batch.production_number} · {batch.batch_code} · {readable(batch.status)}</h4>
      <p>{batch.item_code} · {batch.product} · {batch.recipe_name}, versão {batch.recipe_version}</p>
      {batch.output_code ? <>
        <p>Acabado <LotLink code={batch.output_code} onFind={onFind}/> · {batch.output_status}</p>
        <p>{batch.output_units && amount(batch.output_units, 'un')}
          {batch.nominal_kg && ' · Nominal ' + amount(batch.nominal_kg, 'kg')}
          {batch.actual_kg && ' · Medido ' + amount(batch.actual_kg, 'kg')}</p>
        {batch.finished_at && <p>Finalizado em {stamp(batch.finished_at)} · {batch.finished_by}</p>}
      </> : <p>Acabado ainda não registrado.</p>}
    </article>)}
    {data.inputs.length > 0 && <section>
      <h4>Lotes usados para fabricar o acabado</h4>
      <div className="table-scroll"><table>
        <thead><tr><th>Massada e etapa</th><th>Insumo e lote</th><th>Origem</th><th>Consumo</th></tr></thead>
        <tbody>{data.inputs.map(row => <tr key={row.movement_id}>
          <td>{batchCodes.get(row.batch_id)} · {readable(row.stage)}</td>
          <td>{row.material} · {row.kind}<br/><LotLink code={row.source_code} onFind={onFind}/><br/>
            Lote original {row.source_original_lot} · {row.location}</td>
          <td>{row.manufacturer}{row.supplier && ' · ' + row.supplier}<br/>
            {row.invoice_number ? 'NF ' + row.invoice_number : row.opening_invoice ?? row.opening_reference ?? 'Documento não informado'}
            {row.expires_on && <div>Validade {row.expires_on.split('-').reverse().join('/')}</div>}
          </td>
          <td>{amount(row.quantity, row.unit)}<br/>{stamp(row.consumed_at)} · {row.operator}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
    {data.uses.length > 0 && <section>
      <h4>Onde o lote consultado foi usado</h4>
      <ul>{data.uses.map(row => <li key={row.movement_id} className="break-code">
        {row.source_code} · {batchCodes.get(row.batch_id)} · {row.material} · {readable(row.stage)} · {amount(row.quantity, row.unit)}
        {' · '}{stamp(row.consumed_at)} · {row.operator}
      </li>)}</ul>
    </section>}
    {data.water.length > 0 && <section>
      <h4>Água de processo</h4>
      <ul>{data.water.map(row => <li key={row.id}>
        {batchCodes.get(row.batch_id)} · {amount(row.quantity, row.unit)} · {row.source}
        {' · '}Controle {row.control_reference} · {stamp(row.recorded_at)} · {row.operator}
      </li>)}</ul>
    </section>}
    {data.losses.length > 0 && <section>
      <h4>Perdas de massa registradas</h4>
      <ul>{data.losses.map(row => <li key={row.id}>
        {batchCodes.get(row.batch_id)} · {readable(row.operation)} · {amount(row.quantity, 'kg')}
        {' · '}{row.reason} · {row.destination} · {stamp(row.occurred_at)} · {row.operator}
      </li>)}</ul>
    </section>}
    {data.destinations.length > 0 && <section>
      <h4>Destinos dos acabados vinculados</h4>
      <div className="table-scroll"><table>
        <thead><tr><th>Pedido e cliente</th><th>Lote acabado</th><th>Quantidade</th><th>Despacho</th><th>Recebimento</th></tr></thead>
        <tbody>{data.destinations.map(row => <tr key={row.id}>
          <td>{row.order_number} · {row.customer_name}</td><td><LotLink code={row.output_code} onFind={onFind}/></td>
          <td>{amount(row.quantity,row.unit)}</td><td>{stamp(row.dispatched_at)} · {row.operator}</td>
          <td>{row.delivered_at ? stamp(row.delivered_at) : 'Pendente'}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
  </section>
}
