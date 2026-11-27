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

export default function Dashboard({ accessKey }: { accessKey: string }) {
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
    <h1>Indicadores</h1>
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
    <form className="indicator-filter" onSubmit={event => {
      event.preventDefault()
      setExportError('')
      setExpandedBucket(null)
      setPeriod({ from, to })
    }}>
      <label>Data inicial <input type="date" required max={to || today} value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label>Data final <input type="date" required min={from} max={today} value={to} onChange={event => setTo(event.target.value)} /></label>
      <button type="submit" disabled={exporting}>Consultar</button>
    </form>
    {report.isPending && <p role="status">Carregando indicadores…</p>}
    {report.isError && <p role="alert">Falha ao consultar indicadores. {report.error.message}</p>}
    {report.isSuccess && <>
      <p>Período consultado de {dateLabel(period.from)} a {dateLabel(period.to)}</p>
      <div className="indicator-filter">
        <button type="button" className="secondary" disabled={exporting} onClick={() => void exportReport('pdf')}>Exportar PDF</button>
        <button type="button" className="secondary" disabled={exporting} onClick={() => void exportReport('xlsx')}>Exportar Excel</button>
      </div>
    </>}
    {exporting && <p role="status">Gerando relatório…</p>}
    {exportError && <p role="alert">{exportError}</p>}
    {operations && <section>
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
      <h2>Validade dos lotes com saldo atual</h2>
      <Metrics rows={expiryMetrics} />
    </section>}
    {commercial && <section>
      <h2>Pedidos, entregas e faturamento</h2>
      <Metrics rows={commercialMetrics} />
      <p>{commercialNote}</p>
    </section>}
  </section>
}
