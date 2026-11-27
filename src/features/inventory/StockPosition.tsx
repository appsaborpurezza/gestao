import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { formatStockQuantity } from '../../lib/decimal'
import { downloadFile } from '../../lib/downloadFile'
import { FileSpreadsheet, FileText } from 'lucide-react'
import { Combobox } from '../../ui/Combobox'
import { DataTable, type Column } from '../../ui/DataTable'
import { ErrorState } from '../../ui'
import { buildStockPositionExcel, buildStockPositionPdf,
  type StockPositionRow } from './stockPositionExport'

type Filter = { as_of: string; filter_item: string | null; filter_location: string | null }
type Report = { total: number; rows: StockPositionRow[] }
type Option = { id: string; label: string }
const calendar = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })

export function StockPosition({ items, locations }: { items: Option[]; locations: Option[] }) {
  const [filter, setFilter] = useState<Filter | null>(null)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [itemId, setItemId] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const report = useQuery({
    queryKey: ['inventory', 'stock-position', filter, page, pageSize],
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
      filter_item: itemId || null,
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

  const columns: Column<StockPositionRow>[] = [
    { id: 'item', header: 'Item', cell: row => <span className="ui-cell-stack"><strong>{row.item_description}</strong><small className="ui-code">{row.item_code}</small></span> },
    { id: 'lot', header: 'Lote interno', cell: row => <span className="ui-code">{row.lot_code}</span> },
    { id: 'location', header: 'Local', cell: row => row.location_code },
    { id: 'quantity', header: 'Saldo físico', align: 'end', cell: row => <strong>{formatStockQuantity(row.quantity)} {row.unit}</strong> },
  ]

  return <section>
    <h2>Posição de estoque por data</h2>
    <p>Saldo físico por lote e local ao fim do dia em São Paulo. As descrições exibidas vêm do cadastro atual.</p>
    <form className="ui-inline-form" onSubmit={search}>
      <label>Data da posição <input name="as_of" type="date" defaultValue={today} max={today} required/></label>
      <Combobox label="Item" value={itemId} onChange={setItemId} placeholder="Todos os itens"
        options={[{ value: '', label: 'Todos os itens' }, ...items.map(item => ({ value: item.id, label: item.label }))]}/>
      <label>Local <select name="location"><option value="">Todos</option>
        {locations.map(location => <option key={location.id} value={location.id}>{location.label}</option>)}
      </select></label>
      <div><button>Consultar posição</button></div>
    </form>
    {report.isError && <ErrorState title="Falha ao consultar a posição de estoque" onRetry={() => void report.refetch()}/>}
    {filter && !report.isError && <section>
      <div className="ui-detail-header">
        <h3>Posição em {filter.as_of.split('-').reverse().join('/')}</h3>
        <nav aria-label="Exportações da posição" className="ui-page-header-actions">
          <button type="button" className="secondary" disabled={exporting || !report.data?.total} onClick={() => void exportReport('xlsx')}>
            <FileSpreadsheet aria-hidden="true" size={16}/>Exportar Excel</button>
          <button type="button" className="secondary" disabled={exporting || !report.data?.total} onClick={() => void exportReport('pdf')}>
            <FileText aria-hidden="true" size={16}/>Exportar PDF</button>
        </nav>
      </div>
      {exporting && <p role="status">Gerando arquivo…</p>}
      {exportError && <p className="ui-message" data-tone="danger" role="alert">{exportError}</p>}
      <DataTable caption="Posição de estoque" rows={report.data?.rows} columns={columns}
        rowKey={row => row.lot_code + '/' + row.location_code} loading={report.isFetching}
        total={report.data?.total ?? 0} page={page} pageSize={pageSize} onPageChange={setPage}
        onPageSizeChange={size => { setPageSize(size); setPage(0) }} preferenceKey="stock-position"
        empty={{ title: 'Nenhuma posição com saldo', description: 'Ajuste a data, o item ou o local e consulte de novo.' }}/>
    </section>}
  </section>
}
