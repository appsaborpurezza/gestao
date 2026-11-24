import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { formatStockQuantity } from '../../lib/decimal'
import { downloadFile } from '../../lib/downloadFile'
import { buildStockPositionExcel, buildStockPositionPdf,
  type StockPositionRow } from './stockPositionExport'

type Filter = { as_of: string; filter_item: string | null; filter_location: string | null }
type Report = { total: number; rows: StockPositionRow[] }
type Option = { id: string; label: string }
const pageSize = 25
const calendar = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })

export function StockPosition({ items, locations }: { items: Option[]; locations: Option[] }) {
  const [filter, setFilter] = useState<Filter | null>(null)
  const [page, setPage] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const report = useQuery({
    queryKey: ['inventory', 'stock-position', filter, page],
    enabled: filter !== null,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('stock_position', {
        ...filter!, page_size: pageSize, page_offset: page * pageSize,
      })
      if (error) throw error
      return data as Report
    },
  })
  const today = calendar.format(new Date())

  async function exportReport(format: 'xlsx' | 'pdf') {
    if (!filter || exporting) return
    setExporting(true)
    setExportError('')
    try {
      const { data, error } = await supabase.rpc('export_stock_position', filter)
      if (error) throw error
      const snapshot = data as Report & { generated_at: string }
      const input = {
        date: filter.as_of,
        generatedAt: snapshot.generated_at,
        item: items.find(item => item.id === filter.filter_item)?.label ?? filter.filter_item ?? 'Todos',
        location: locations.find(location => location.id === filter.filter_location)?.label ?? filter.filter_location ?? 'Todos',
        rows: snapshot.rows,
      }
      const name = 'posicao-estoque-' + filter.as_of
      if (format === 'pdf') (await buildStockPositionPdf(input)).save(name + '.pdf')
      else {
        const content = await buildStockPositionExcel(input)
        downloadFile(new Blob([content as ArrayBuffer], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }), name + '.xlsx')
      }
    } catch {
      setExportError('Falha ao exportar a posição de estoque.')
    } finally {
      setExporting(false)
    }
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const next = {
      as_of: String(fields.get('as_of')),
      filter_item: String(fields.get('item') || '') || null,
      filter_location: String(fields.get('location') || '') || null,
    }
    if (page === 0 && filter?.as_of === next.as_of && filter.filter_item === next.filter_item
      && filter.filter_location === next.filter_location) {
      void report.refetch()
      return
    }
    setPage(0)
    setFilter(next)
  }

  return <section>
    <h2>Posição de estoque por data</h2>
    <p>Saldo físico por lote e local ao fim do dia em São Paulo. As descrições exibidas vêm do cadastro atual.</p>
    <form onSubmit={search}>
      <label>Data da posição <input name="as_of" type="date" defaultValue={today} max={today} required/></label>
      <label>Item <select name="item"><option value="">Todos</option>
        {items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <label>Local <select name="location"><option value="">Todos</option>
        {locations.map(location => <option key={location.id} value={location.id}>{location.label}</option>)}
      </select></label>
      <button>Consultar posição</button>
    </form>
    {filter && report.isFetching && <p role="status">Consultando posição…</p>}
    {report.isError && <p role="alert">Falha ao consultar a posição de estoque.</p>}
    {report.isSuccess && <section>
      <h3>Posição em {filter!.as_of.split('-').reverse().join('/')}</h3>
      <nav aria-label="Exportações da posição">
        <button type="button" disabled={exporting} onClick={() => void exportReport('xlsx')}>Exportar Excel</button>
        <button type="button" disabled={exporting} onClick={() => void exportReport('pdf')}>Exportar PDF</button>
      </nav>
      {exporting && <p role="status">Gerando arquivo…</p>}
      {exportError && <p role="alert">{exportError}</p>}
      {report.data.total === 0 && <p>Nenhuma posição com saldo para os filtros informados.</p>}
      {report.data.rows.length > 0 && <div className="table-scroll"><table>
        <thead><tr><th>Item</th><th>Lote interno</th><th>Local</th><th>Saldo físico</th></tr></thead>
        <tbody>{report.data.rows.map(row => <tr key={row.lot_code + '/' + row.location_code}>
          <td>{row.item_code} · {row.item_description}</td><td>{row.lot_code}</td><td>{row.location_code}</td>
          <td>{formatStockQuantity(row.quantity)} {row.unit}</td>
        </tr>)}</tbody>
      </table></div>}
      {(report.data.total > pageSize || page > 0) && <nav aria-label="Paginação da posição">
        <button type="button" onClick={() => setPage(page - 1)} disabled={page === 0}>Anterior</button>
        <span>Página {page + 1} · {report.data.total} posições</span>
        <button type="button" onClick={() => setPage(page + 1)} disabled={(page + 1) * pageSize >= report.data.total}>Próxima</button>
      </nav>}
    </section>}
  </section>
}
