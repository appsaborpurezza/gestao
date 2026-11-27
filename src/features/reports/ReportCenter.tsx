import { canNavigate } from '../../layouts/AppShell'

const reports = [
  { title: 'Indicadores por período', detail: 'Produção, perdas e indicadores comerciais conforme o perfil. Exportação em PDF e Excel.', module: 'dashboard' },
  { title: 'Posição e movimentações de estoque', detail: 'Consulte a posição por data, os lotes e as movimentações. A posição histórica pode ser exportada.', module: 'inventory' },
  { title: 'Pedidos e faturamento', detail: 'Consulte pedidos e o faturamento registrado. Vendas pode emitir o documento comercial.', module: 'orders' },
  { title: 'Expedições e entregas', detail: 'Consulte o histórico de expedições, comprovações e devoluções.', module: 'shipping' },
  { title: 'Rastreabilidade e genealogia', detail: 'Consulte a origem, o processamento e o destino de lotes.', module: 'traceability' },
  { title: 'Perdas e descartes', detail: 'Consulte o histórico de perdas e descartes por período.', module: 'losses' },
]

export default function ReportCenter({ role, onNavigate }: { role: string; onNavigate: (id: string) => void }) {
  return <section className="panel">
    <h1>Central de relatórios</h1>
    <ul className="report-center">
      {reports.filter(report => canNavigate(report.module, role)).map(report => <li key={report.module}>
        <h2>{report.title}</h2>
        <p>{report.detail}</p>
        <button type="button" className="secondary" onClick={() => onNavigate(report.module)}>Abrir consulta<span className="sr-only"> {report.title}</span></button>
      </li>)}
    </ul>
  </section>
}
