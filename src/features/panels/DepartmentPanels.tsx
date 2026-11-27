import { useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Boxes, CalendarX, ClipboardList, Factory, FileSpreadsheet, FileText, Gauge, LayoutDashboard, Printer, Receipt, Recycle, Scale, ShieldAlert, Timer, Truck, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { downloadFile } from '../../lib/downloadFile'
import { ErrorState, PageHeader, Skeleton, StatCard } from '../../ui'
import { Tabs } from '../../ui/Tabs'
import { useSessionState } from '../../ui/filters'
import { SavedViews } from '../../ui/SavedViews'
import { buildIndicatorsExcel, buildIndicatorsPdf, dateLabel, type IndicatorSection } from '../dashboard/indicatorExport'
import { dashboardPeriod, dashboardPresets } from '../dashboard/dashboardPeriods'
import {
  brl, classificationLabels, emptyPanelFilters, filterPayload, kg, num, panelSections, panelTitles, pct,
  type PanelFilters, type PanelId, type Panels,
} from './panelData'

const filterLabels: Record<keyof PanelFilters, string> = { recipe: 'Receita', customer: 'Cliente', classification: 'Classificação' }
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

type ViewState = { panel: PanelId; from: string; to: string; filters: PanelFilters }

export default function DepartmentPanels({ accessKey, onNavigate }: { accessKey: string; onNavigate: (module: string) => void }) {
  const initial = dashboardPeriod('month', today())
  const [view, setView] = useSessionState<ViewState>('panels:' + accessKey, { panel: 'production', ...initial, filters: emptyPanelFilters })
  const [from, setFrom] = useState(view.from)
  const [to, setTo] = useState(view.to)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [printing, setPrinting] = useState<IndicatorSection[] | null>(null)
  const filters = { ...emptyPanelFilters, ...view.filters }
  const setFilters = (next: PanelFilters) => setView(current => ({ ...current, filters: next }))
  const setFilter = (key: keyof PanelFilters, value: string) => setFilters({ ...filters, [key]: value })

  const query = useQuery({
    queryKey: ['operations-panels', accessKey, view.from, view.to, filters],
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.rpc('operations_panels', { from_day: view.from, to_day: view.to, filters: filterPayload(filters) }).abortSignal(signal)
      if (error) throw new Error(error.code === '22023' ? error.message : 'Não foi possível consultar os painéis. Tente novamente.')
      return data as Panels
    },
  })
  const data = query.data
  const available: PanelId[] = data ? (['production', 'stock', 'quality', 'commercial'] as PanelId[]).filter(id => data[id] !== null) : []
  const panel = available.includes(view.panel) ? view.panel : available[0] ?? view.panel
  const sections = data ? panelSections(panel, data) : []
  const exportInput = () => ({ from: view.from, to: view.to, issuedAt: new Date(),
    sections: [{ title: 'Filtros', columns: ['Filtro', 'Valor'], rows: activeFilters.length ? activeFilters.map(([key, value]) => [filterLabels[key], label(key, value)]) : [['Nenhum', '—']] }, ...sections]
      .map(section => ({ ...section, title: section.title.slice(0, 31) })) })
  const activeFilters = (Object.entries(filters) as [keyof PanelFilters, string][]).filter(([, value]) => value)
  const label = (key: keyof PanelFilters, value: string) => key === 'classification' ? classificationLabels[value] ?? value : value

  async function exportPanel(format: 'pdf' | 'xlsx') {
    setBusy(true); setMessage('')
    try {
      const filename = `painel-${panel}-${view.from}-${view.to}.${format}`
      if (format === 'pdf') downloadFile((await buildIndicatorsPdf(exportInput())).output('blob'), filename)
      else downloadFile(new Blob([await buildIndicatorsExcel(exportInput()) as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename)
    } catch {
      setMessage('Falha ao gerar o arquivo. Tente novamente.')
    } finally { setBusy(false) }
  }
  function print() {
    flushSync(() => setPrinting(exportInput().sections))
    window.print()
    setPrinting(null)
  }

  const presetActive = (preset: typeof dashboardPresets[number][0]) => { const d = dashboardPeriod(preset, today()); return d.from === view.from && d.to === view.to }
  const applyPeriod = (period: { from: string; to: string }) => { setFrom(period.from); setTo(period.to); setView(current => ({ ...current, ...period })) }

  return <section className="panel indicator-panel">
    <PageHeader icon={LayoutDashboard} title="Painéis departamentais"
      description={`${panelTitles[panel]} · ${dateLabel(view.from)} a ${dateLabel(view.to)}${query.isFetching && data ? ' · atualizando…' : ''}`}
      actions={data && <>
        <button type="button" className="secondary" disabled={busy} onClick={() => void exportPanel('pdf')}><FileText aria-hidden="true" size={16}/>PDF</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void exportPanel('xlsx')}><FileSpreadsheet aria-hidden="true" size={16}/>Excel</button>
        <button type="button" className="secondary" disabled={busy} onClick={print}><Printer aria-hidden="true" size={16}/>Imprimir</button>
      </>}/>
    <div className="ui-filterbar" role="search">
      <div className="ui-filterbar-fields">
        <div className="indicator-filter" role="group" aria-label="Atalhos de período">
          {dashboardPresets.map(([preset, text]) => <button type="button" key={preset} className="secondary"
            aria-pressed={presetActive(preset)} onClick={() => applyPeriod(dashboardPeriod(preset, today()))}>{text}</button>)}
        </div>
        <form className="ui-inline-form" onSubmit={event => { event.preventDefault(); applyPeriod({ from, to }) }}>
          <label>Data inicial <input type="date" required max={to || today()} value={from} onChange={event => setFrom(event.target.value)}/></label>
          <label>Data final <input type="date" required min={from} max={today()} value={to} onChange={event => setTo(event.target.value)}/></label>
          <div><button type="submit">Consultar</button></div>
        </form>
      </div>
    </div>
    <SavedViews<PanelFilters> scope={'panels:' + panel} current={filters} onApply={setFilters}
      presets={[{ id: 'todos', label: 'Sem filtros', filters: emptyPanelFilters }]}/>
    {activeFilters.length > 0 && <div className="panel-filters" role="group" aria-label="Filtros aplicados">
      {activeFilters.map(([key, value]) => <button key={key} type="button" className="panel-filter-chip" onClick={() => setFilter(key, '')}>
        {filterLabels[key]}: {label(key, value)} <X aria-hidden="true" size={14}/><span className="sr-only"> (remover filtro)</span>
      </button>)}
    </div>}
    {query.isPending && <Skeleton lines={6} label="Carregando painéis…"/>}
    {query.isError && <ErrorState title="Falha ao consultar os painéis" description={query.error.message} onRetry={() => void query.refetch()}/>}
    {message && <p className="ui-message" data-tone="danger" role="alert">{message}</p>}
    {data && <>
      <Tabs label="Painel" value={panel} onChange={id => setView(current => ({ ...current, panel: id }))}
        items={available.map(id => ({ id, label: panelTitles[id] }))}/>
      <div className="ui-stat-grid">
        {panel === 'production' && data.production && <>
          <StatCard icon={Gauge} label="Atendimento do planejado" value={pct(data.production.plan.attainment_pct)}
            context={`${kg(data.production.plan.produced_kg)} de ${kg(data.production.plan.planned_kg)}`}/>
          <StatCard icon={AlertTriangle} label="Ordens atrasadas" value={data.production.plan.late}
            tone={data.production.plan.late ? 'danger' : 'success'} context="Abrir o Kanban" onOpen={() => onNavigate('production-board')}/>
          <StatCard icon={Scale} label="Rendimento" value={pct(data.production.yield_pct)} context="Peso medido sobre o planejado"/>
          <StatCard icon={Timer} label="Do início à finalização" value={num(data.production.lead_hours)} unit="h" context={`${data.production.finished_batches} massadas finalizadas`}/>
        </>}
        {panel === 'stock' && data.stock && <>
          <StatCard icon={Boxes} label="Peso em estoque" value={num(data.stock.kg)} unit="kg" context={`${data.stock.lots} lotes com saldo`} onOpen={() => onNavigate('inventory')}/>
          <StatCard icon={Factory} label="Produto acabado liberado" value={num(data.stock.finished_goods_kg)} unit="kg"/>
          <StatCard icon={CalendarX} label="Vencidos ou vencendo hoje" value={data.stock.expired} tone={data.stock.expired ? 'danger' : 'success'}
            context={`${data.stock.expiring_7} em 7 dias`} onOpen={() => onNavigate('inventory')}/>
          <StatCard icon={ShieldAlert} label="Quarentena e bloqueio" value={data.stock.quarantine + data.stock.blocked}
            tone={data.stock.blocked ? 'warning' : 'neutral'} context={`${data.stock.blocked} bloqueados ou reprovados`} onOpen={() => onNavigate('inventory')}/>
        </>}
        {panel === 'quality' && data.quality && <>
          <StatCard icon={Recycle} label="Perdas sobre a produção" value={pct(data.quality.loss_pct)} context={kg(data.quality.loss_kg)}
            tone={Number(data.quality.loss_pct ?? 0) > 3 ? 'warning' : 'neutral'} onOpen={() => onNavigate('losses')}/>
          <StatCard icon={Scale} label="Abaixo do peso nominal" value={data.quality.underweight} context={`de ${data.quality.measured} medidas`}
            tone={data.quality.underweight ? 'warning' : 'success'}/>
          <StatCard icon={ShieldAlert} label="Recolhimentos em aberto" value={data.quality.recalls_open}
            tone={data.quality.recalls_open ? 'danger' : 'success'} context={`${data.quality.recalls_opened} abertos no período`} onOpen={() => onNavigate('recall')}/>
          <StatCard icon={ClipboardList} label="Lotes aguardando liberação" value={data.quality.pending_release} onOpen={() => onNavigate('inventory')}/>
        </>}
        {panel === 'commercial' && data.commercial && <>
          <StatCard icon={ClipboardList} label="Pedidos no período" value={data.commercial.orders} context={kg(data.commercial.ordered_kg)} onOpen={() => onNavigate('orders')}/>
          <StatCard icon={AlertTriangle} label="Pedidos atrasados" value={data.commercial.overdue}
            tone={data.commercial.overdue ? 'danger' : 'success'} onOpen={() => onNavigate('orders')}/>
          <StatCard icon={Truck} label="Expedições" value={data.commercial.shipments} context={`${data.commercial.shipped} pedidos expedidos`} onOpen={() => onNavigate('shipping')}/>
          <StatCard icon={Receipt} label="Faturado" value={brl(data.commercial.billed_amount)}/>
        </>}
      </div>
      <p className="panel-hint">Clique em uma receita, cliente ou classificação nas tabelas para filtrar todos os painéis.</p>
      {sections.map((section, index) => <PanelTable key={section.title} section={section}
        onRow={rowFilter(panel, index, data, setFilter)}/>)}
    </>}
    {printing && createPortal(<div className="report-print">
      <h1>Sabor Purezza SMART | {panelTitles[panel]}</h1>
      <p>Período de {dateLabel(view.from)} a {dateLabel(view.to)}</p>
      {printing.map(section => <PanelTable key={section.title} section={section}/>)}
    </div>, document.body)}
  </section>
}

/** Qual coluna de qual tabela aplica filtro ao ser clicada. */
function rowFilter(panel: PanelId, index: number, data: Panels, setFilter: (key: keyof PanelFilters, value: string) => void) {
  if (panel === 'production' && index === 3) return (row: number) => setFilter('recipe', data.production!.by_recipe[row]!.recipe_name)
  if (panel === 'production' && index === 4) return (row: number) => setFilter('customer', data.production!.orders_due[row]!.customer_name)
  if (panel === 'stock' && index === 2) return (row: number) => setFilter('classification', data.stock!.by_classification[row]!.classification)
  if (panel === 'commercial' && index === 1) return (row: number) => setFilter('customer', data.commercial!.customers[row]!.customer_name)
  return undefined
}

function PanelTable({ section, onRow }: { section: IndicatorSection; onRow?: (row: number) => void }) {
  const filterColumn = section.columns[0] === 'OP' ? 2 : 0
  return <section className="ui-detail">
    <div className="indicator-table"><table>
      <caption>{section.title}</caption>
      <thead><tr>{section.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
      <tbody>{section.rows.length ? section.rows.map((row, rowIndex) => <tr key={rowIndex}>
        {row.map((cell, cellIndex) => {
          const content = onRow && cellIndex === filterColumn
            ? <button type="button" className="ui-link-button" onClick={() => onRow(rowIndex)}>{cell}<span className="sr-only"> (filtrar)</span></button>
            : cell
          return cellIndex === 0 ? <th key={cellIndex} scope="row">{content}</th> : <td key={cellIndex}>{content}</td>
        })}
      </tr>) : <tr><td colSpan={section.columns.length}>Sem registros no período.</td></tr>}</tbody>
    </table></div>
    {section.note && <p>{section.note}</p>}
  </section>
}
