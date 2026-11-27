import { Fragment, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatBrl, formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { downloadFile } from '../../lib/downloadFile'
import { buildIndicatorsExcel, buildIndicatorsPdf, dateLabel, type IndicatorSection } from './indicatorExport'
import { lossPareto } from './lossPareto'
import { groupProductionSeries, type Grouping, type ProductionDay } from './productionSeries'
import { dashboardPreferences } from './dashboardPreferences'
import { dashboardPeriod, dashboardPresets } from './dashboardPeriods'
import { previousPeriod, trend, type Trend } from './trend'
import { AlertTriangle, BadgeCheck, CalendarX, ClipboardList, Factory, FileSpreadsheet, FileText, Gauge, Receipt, Scale, TrendingDown, TrendingUp, Minus } from 'lucide-react'
import { ErrorState, PageHeader, Skeleton, StatCard } from '../../ui'
import { Tabs } from '../../ui/Tabs'

type Operations = {
  finished_count: number
  measured_count: number
  measured_kg: string | null
  nominal_kg: string | null
  avg_measured_kg: string | null
  mass_loss_kg: string | null
  linked_loss_pct: string | null
  expired_lots: number
  expiring_released_lots: number
  daily: ProductionDay[]
  loss_causes: { reason: string; kg: string }[]
}
type Commercial = {
  open_orders: number
  overdue_orders: number
  otif_eligible: number
  otif_on_time_complete: number
  otif_pct: string | null
  billing_count: number
  billed_amount: string | null
}
type Report = { operations: Operations | null; commercial: Commercial | null }
const kg = (value: string | null) => value === null ? 'N/D' : `${formatStockQuantity(value)} kg`
const percent = (value: string | null) => value === null ? 'N/D' : `${formatStockQuantity(value)}%`
const productionNote = 'O percentual considera perdas vinculadas no período e exige peso registrado em todas as massadas finalizadas.'
const commercialNote = 'O OTIF usa pedidos do período cujo prazo já terminou. Todas as quantidades precisam ter sido entregues até o fim do dia previsto, no horário de São Paulo. O faturamento usa a data de emissão.'
const seriesOptions = {
  day: { title: 'Produção e perdas por dia', column: 'Data', note: undefined },
  week: { title: 'Produção e perdas por semana', column: 'Segunda-feira', note: 'A semana começa na segunda-feira. Cada linha inclui somente as datas do período consultado.' },
  month: { title: 'Produção e perdas por mês', column: 'Mês', note: 'Cada linha inclui somente as datas do período consultado.' },
}
const seriesMeasures = ['Finalizadas', 'Pesadas', 'Peso medido', 'Perdas']
const seriesValues = (day: ProductionDay) => [
  day.finished_count, day.measured_count, kg(day.measured_kg), kg(day.loss_kg),
]

function Metrics({ rows }: { rows: [string, string | number][] }) {
  return <dl className="indicator-grid">{rows.map(([label, value]) => (
    <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
  ))}</dl>
}

function TrendNote({ value, better }: { value: Trend; better: 'up' | 'down' }) {
  if (!value) return <span className="ui-trend">Sem base no período anterior</span>
  const Icon = value.direction === 'up' ? TrendingUp : value.direction === 'down' ? TrendingDown : Minus
  const tone = value.direction === 'flat' ? 'neutral' : value.direction === better ? 'good' : 'bad'
  return <span className="ui-trend" data-tone={tone}><Icon aria-hidden="true" size={14}/>{value.label}
    <span className="sr-only"> em relação ao período anterior</span><span aria-hidden="true"> vs. anterior</span></span>
}

type View = 'all' | 'production' | 'commercial' | 'quality'

export default function Dashboard({ accessKey, onNavigate }: { accessKey: string; onNavigate?: (module: string) => void }) {
  const [view, setView] = useState<View>('all')
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const preferenceKey = 'purezza:indicators:' + accessKey
  const [initial] = useState(() => dashboardPreferences({
    getItem: key => window.sessionStorage.getItem(key),
  }, preferenceKey, today))
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [period, setPeriod] = useState({ from: initial.from, to: initial.to })
  const [grouping, setGrouping] = useState<Grouping>(initial.grouping)
  const [expandedBucket, setExpandedBucket] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const report = useQuery({
    queryKey: ['role-dashboard', accessKey, period],
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.rpc('role_dashboard', { from_day: period.from, to_day: period.to }).abortSignal(signal)
      if (error) throw new Error(error.message)
      return data as Report
    },
  })
  const before = previousPeriod(period)
  const previous = useQuery({
    queryKey: ['role-dashboard', accessKey, before],
    enabled: report.isSuccess,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.rpc('role_dashboard', { from_day: before.from, to_day: before.to }).abortSignal(signal)
      if (error) throw new Error(error.message)
      return data as Report
    },
  })
  useEffect(() => {
    if (!report.isSuccess) return
    try {
      window.sessionStorage.setItem(preferenceKey, JSON.stringify({ ...period, grouping }))
    } catch {
      // Storage is optional for running the report.
    }
  }, [grouping, period, preferenceKey, report.isSuccess])
  const operations = report.data?.operations
  const commercial = report.data?.commercial
  const prevOps = previous.data?.operations
  const prevCom = previous.data?.commercial
  const show = (section: Exclude<View, 'all'>) => view === 'all' || view === section
  const productionMetrics: [string, string | number][] = operations ? [
    ['Massadas finalizadas', operations.finished_count],
    ['Massadas com peso registrado', `${operations.measured_count} de ${operations.finished_count}`],
    ['Peso medido', kg(operations.measured_kg)],
    ['Peso nominal', kg(operations.nominal_kg)],
    ['Média dos pesos medidos', kg(operations.avg_measured_kg)],
    ['Perdas de massa registradas', kg(operations.mass_loss_kg)],
    ['Percentual de perdas das massadas finalizadas', percent(operations.linked_loss_pct)],
  ] : []
  const expiryMetrics: [string, string | number][] = operations ? [
    ['Vencidos ou com vencimento hoje', operations.expired_lots],
    ['Liberados com vencimento nos próximos sete dias', operations.expiring_released_lots],
  ] : []
  const commercialMetrics: [string, string | number][] = commercial ? [
    ['Pedidos com expedição em aberto', commercial.open_orders],
    ['Pedidos em aberto com prazo vencido', commercial.overdue_orders],
    ['Entregas completas no prazo (OTIF)', percent(commercial.otif_pct)],
    ['Pedidos completos no prazo', `${commercial.otif_on_time_complete} de ${commercial.otif_eligible}`],
    ['Registros de faturamento emitidos', commercial.billing_count],
    ['Valor emitido', commercial.billed_amount === null ? 'N/D' : formatBrl(commercial.billed_amount)],
  ] : []
  const series = seriesOptions[grouping]
  const seriesColumns = [series.column, ...seriesMeasures]
  const seriesRows = groupProductionSeries(operations?.daily ?? [], grouping).map(({ total, days }) => ({
    id: total.day,
    label: grouping === 'month' ? dateLabel(total.day).slice(3) : dateLabel(total.day),
    values: seriesValues(total),
    weights: [total.measured_kg, total.loss_kg],
    days,
  }))
  const weightScale = seriesRows.reduce<string | null>((maximum, row) => row.weights.reduce(
    (largest, weight) => weight !== null && Number(weight) > Number(largest) ? weight : largest,
    maximum,
  ), null)
  const causes = lossPareto(operations?.loss_causes ?? [])
  const causeColumns = ['Motivo', 'Perdas', 'Participação', 'Acumulado']
  const causeTitle = 'Pareto de perdas de massa'
  const causeNote = 'Cada participação usa o total em kg das perdas de massa registradas no período. O acumulado soma os pesos antes do arredondamento.'

  async function exportReport(format: 'pdf' | 'xlsx') {
    setExportError('')
    setExporting(true)
    const sections: IndicatorSection[] = []
    const metricColumns = ['Indicador', 'Valor']
    if (operations) {
      sections.push({ title: 'Produção e perdas', columns: metricColumns, rows: productionMetrics, note: productionNote })
      if (seriesRows.length) {
        sections.push({ title: series.title, columns: seriesColumns, note: series.note,
          rows: seriesRows.map(row => [row.label, ...row.values]) })
        if (grouping !== 'day') sections.push({
          title: seriesOptions.day.title, columns: [seriesOptions.day.column, ...seriesMeasures],
          rows: operations.daily.map(day => [dateLabel(day.day), ...seriesValues(day)]),
        })
      }
      if (causes.length) sections.push({
        title: causeTitle, columns: causeColumns, note: causeNote,
        rows: causes.map(cause => [cause.reason, kg(cause.kg), cause.share.display, cause.cumulative]),
      })
      sections.push({ title: 'Validade dos lotes', columns: metricColumns, rows: expiryMetrics,
        note: 'Contagem pelo saldo atual, independentemente do período consultado.' })
    }
    if (commercial) sections.push({
      title: 'Pedidos, entregas e faturamento', columns: metricColumns, rows: commercialMetrics, note: commercialNote,
    })
    try {
      const input = { ...period, issuedAt: new Date(), sections }
      const filename = `indicadores-${period.from}-${period.to}.${format}`
      if (format === 'pdf') {
        const document = await buildIndicatorsPdf(input)
        downloadFile(document.output('blob'), filename)
      } else {
        const content = await buildIndicatorsExcel(input)
        downloadFile(new Blob([content as ArrayBuffer], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }), filename)
      }
    } catch {
      setExportError('Falha ao gerar o relatório. Tente novamente.')
    } finally {
      setExporting(false)
    }
  }

  return <section className="panel indicator-panel">
    <PageHeader icon={Gauge} title="Visão geral"
      description={`Indicadores de ${dateLabel(period.from)} a ${dateLabel(period.to)}, comparados ao período anterior de mesmo tamanho.`}
      actions={report.isSuccess && <>
        <button type="button" className="secondary" disabled={exporting} onClick={() => void exportReport('pdf')}><FileText aria-hidden="true" size={16}/>Exportar PDF</button>
        <button type="button" className="secondary" disabled={exporting} onClick={() => void exportReport('xlsx')}><FileSpreadsheet aria-hidden="true" size={16}/>Exportar Excel</button>
      </>}/>
    <div className="ui-filterbar" role="search">
      <div className="ui-filterbar-fields">
        <div className="indicator-filter" role="group" aria-label="Atalhos de período">
          {dashboardPresets.map(([preset, label]) => {
            const dates = dashboardPeriod(preset, today)
            return <button type="button" key={preset} className="secondary" disabled={exporting}
              aria-pressed={dates.from === period.from && dates.to === period.to}
              onClick={() => {
                setFrom(dates.from)
                setTo(dates.to)
                setPeriod(dates)
                setExpandedBucket(null)
                setExportError('')
              }}>{label}</button>
          })}
        </div>
        <form className="ui-inline-form" onSubmit={event => {
          event.preventDefault()
          setExportError('')
          setExpandedBucket(null)
          setPeriod({ from, to })
        }}>
          <label>Data inicial <input type="date" required max={to || today} value={from} onChange={event => setFrom(event.target.value)} /></label>
          <label>Data final <input type="date" required min={from} max={today} value={to} onChange={event => setTo(event.target.value)} /></label>
          <div><button type="submit" disabled={exporting}>Consultar</button></div>
        </form>
      </div>
    </div>
    {report.isPending && <Skeleton lines={6} label="Carregando indicadores…"/>}
    {report.isError && <ErrorState title="Falha ao consultar indicadores" description={report.error.message} onRetry={() => void report.refetch()}/>}
    {exporting && <p role="status">Gerando relatório…</p>}
    {exportError && <p className="ui-message" data-tone="danger" role="alert">{exportError}</p>}
    {report.isSuccess && <>
      <Tabs label="Departamento" value={view} onChange={setView} items={[
        { id: 'all', label: 'Todos' },
        { id: 'production', label: 'Produção', hidden: !operations },
        { id: 'quality', label: 'Qualidade e estoque', hidden: !operations },
        { id: 'commercial', label: 'Comercial', hidden: !commercial },
      ]}/>
      <div className="ui-stat-grid">
        {operations && show('production') && <>
          <StatCard icon={Factory} label="Massadas finalizadas" value={operations.finished_count}
            context={<TrendNote value={trend(operations.finished_count, prevOps?.finished_count)} better="up"/>}
            onOpen={onNavigate && (() => onNavigate('production-board'))}/>
          <StatCard icon={Scale} label="Peso medido" value={operations.measured_kg === null ? 'N/D' : formatStockQuantity(operations.measured_kg)}
            unit={operations.measured_kg === null ? undefined : 'kg'}
            context={<TrendNote value={trend(operations.measured_kg, prevOps?.measured_kg)} better="up"/>}/>
          <StatCard icon={AlertTriangle} label="Perdas sobre a produção" value={percent(operations.linked_loss_pct)}
            tone={operations.linked_loss_pct !== null && Number(operations.linked_loss_pct) > 3 ? 'warning' : 'neutral'}
            context={<TrendNote value={trend(operations.linked_loss_pct, prevOps?.linked_loss_pct, 'points')} better="down"/>}
            onOpen={onNavigate && (() => onNavigate('losses'))}/>
        </>}
        {operations && show('quality') && <>
          <StatCard icon={CalendarX} label="Lotes vencidos ou vencendo hoje" value={operations.expired_lots}
            tone={operations.expired_lots > 0 ? 'danger' : 'success'} context="Saldo atual"
            onOpen={onNavigate && (() => onNavigate('inventory'))}/>
          <StatCard icon={CalendarX} label="Liberados vencendo em 7 dias" value={operations.expiring_released_lots}
            tone={operations.expiring_released_lots > 0 ? 'warning' : 'success'} context="Saldo atual"
            onOpen={onNavigate && (() => onNavigate('inventory'))}/>
        </>}
        {commercial && show('commercial') && <>
          <StatCard icon={ClipboardList} label="Pedidos em aberto" value={commercial.open_orders} context="Situação atual"
            onOpen={onNavigate && (() => onNavigate('orders'))}/>
          <StatCard icon={AlertTriangle} label="Pedidos atrasados" value={commercial.overdue_orders}
            tone={commercial.overdue_orders > 0 ? 'danger' : 'success'} context="Situação atual"
            onOpen={onNavigate && (() => onNavigate('orders'))}/>
          <StatCard icon={BadgeCheck} label="OTIF (completo e no prazo)" value={percent(commercial.otif_pct)}
            context={<TrendNote value={trend(commercial.otif_pct, prevCom?.otif_pct, 'points')} better="up"/>}/>
          <StatCard icon={Receipt} label="Valor faturado" value={commercial.billed_amount === null ? 'N/D' : formatBrl(commercial.billed_amount)}
            context={<TrendNote value={trend(commercial.billed_amount, prevCom?.billed_amount)} better="up"/>}/>
        </>}
      </div>
    </>}
    {operations && (show('production') || show('quality')) && <section className="ui-detail">
      {show('production') && <>
      <h2>Produção e perdas</h2>
      <Metrics rows={productionMetrics} />
      <p>{productionNote}</p>
      {seriesRows.length > 0 && <>
        <div className="indicator-filter"><label>Agrupar série por
          <select value={grouping} disabled={exporting} onChange={event => {
            setExpandedBucket(null)
            setGrouping(event.target.value as Grouping)
          }}>
            <option value="day">Dia</option>
            <option value="week">Semana</option>
            <option value="month">Mês</option>
          </select>
        </label></div>
        {series.note && <p>{series.note}</p>}
        {weightScale && <p>As barras de peso medido e perdas usam a mesma escala, até {kg(weightScale)}.</p>}
        <div className="indicator-table"><table>
          <caption>{series.title}</caption>
          <thead><tr>{seriesColumns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
          <tbody>{seriesRows.map(row => <Fragment key={row.id}>
            <tr>
              <th scope="row">{grouping === 'day' ? row.label : <button type="button" className="secondary"
                aria-expanded={expandedBucket === row.id}
                aria-label={`Dias de ${row.label}`}
                onClick={() => setExpandedBucket(expandedBucket === row.id ? null : row.id)}>
                {row.label} · {expandedBucket === row.id ? 'Ocultar dias' : 'Ver dias'}
              </button>}</th>
              <td>{row.values[0]}</td>
              <td>{row.values[1]}</td>
              {row.weights.map((weight, index) => <td key={seriesMeasures[index + 2]} className="indicator-weight">
                {kg(weight)}
                {weight !== null && weightScale && <div className="indicator-weight-track" aria-hidden="true">
                  <span className={index === 0 ? 'indicator-weight-measured' : 'indicator-weight-loss'}
                    style={{ width: `${100 * (Number(weight) / Number(weightScale))}%` }} />
                </div>}
              </td>)}
            </tr>
            {expandedBucket === row.id && row.days.map(day => <tr key={day.day} className="indicator-detail">
              <th scope="row">{dateLabel(day.day)}</th>
              {seriesValues(day).map((value, index) => <td key={seriesMeasures[index]}>{value}</td>)}
            </tr>)}
          </Fragment>)}</tbody>
        </table></div>
      </>}
      <h3>{causeTitle}</h3>
      {causes.length ? <>
        <p>{causeNote}</p>
        <div className="indicator-table"><table aria-label={causeTitle}>
          <thead><tr>{causeColumns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
          <tbody>{causes.map(cause => <tr key={cause.reason}>
            <th scope="row">{cause.reason}</th><td>{kg(cause.kg)}</td>
            <td><meter aria-hidden="true" min={0} max={100} value={cause.share.value} /> {cause.share.display}</td>
            <td>{cause.cumulative}</td>
          </tr>)}</tbody>
        </table></div>
      </> : <p>N/D. Nenhuma perda de massa registrada no período.</p>}
      </>}
      {show('quality') && <>
      <h2>Validade dos lotes com saldo atual</h2>
      <Metrics rows={expiryMetrics} />
      </>}
    </section>}
    {commercial && show('commercial') && <section className="ui-detail">
      <h2>Pedidos, entregas e faturamento</h2>
      <Metrics rows={commercialMetrics} />
      <p>{commercialNote}</p>
    </section>}
  </section>
}
