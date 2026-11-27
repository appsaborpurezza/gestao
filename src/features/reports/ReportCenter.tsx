import { lazy, Suspense, useState } from 'react'
import { canNavigate } from '../../layouts/AppShell'

const Dashboard = lazy(() => import('../dashboard/Dashboard'))
const reports = [
  { category: 'Indicadores', title: 'Indicadores por período', detail: 'Produção, perdas e indicadores comerciais conforme o perfil. Exportação em PDF e Excel.', module: 'dashboard' },
  { category: 'Estoque', title: 'Posição e movimentações de estoque', detail: 'Consulte a posição por data, os lotes e as movimentações. A posição histórica pode ser exportada.', module: 'inventory' },
  { category: 'Comercial', title: 'Pedidos e faturamento', detail: 'Consulte pedidos e o faturamento registrado. Vendas pode emitir o documento comercial.', module: 'orders' },
  { category: 'Comercial', title: 'Expedições e entregas', detail: 'Consulte o histórico de expedições, comprovações e devoluções.', module: 'shipping' },
  { category: 'Qualidade', title: 'Rastreabilidade e genealogia', detail: 'Consulte a origem, o processamento e o destino de lotes.', module: 'traceability' },
  { category: 'Qualidade', title: 'Perdas e descartes', detail: 'Consulte o histórico de perdas e descartes por período.', module: 'losses' },
]

const searchKey = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR')

export default function ReportCenter({ role, accountScope, onNavigate }: {
  role: string; accountScope: string; onNavigate: (id: string) => void
}) {
  const [term, setTerm] = useState('')
  const [category, setCategory] = useState('')
  const [preview, setPreview] = useState(false)
  const allowed = reports.filter(report => canNavigate(report.module, role))
  const categories = [...new Set(allowed.map(report => report.category))]
  const needle = searchKey(term.trim())
  const visible = allowed.filter(report => (!category || report.category === category)
    && searchKey(`${report.title} ${report.detail}`).includes(needle))
  if (preview) return <>
    <button type="button" className="secondary" onClick={() => setPreview(false)}>Voltar à central de relatórios</button>
    <Suspense fallback={<p role="status">Abrindo relatório…</p>}>
      <Dashboard accessKey={accountScope}/>
    </Suspense>
  </>
  return <section className="panel">
    <h1>Central de relatórios</h1>
    <div className="indicator-filter">
      <label>Buscar relatório <input type="search" value={term} onChange={event => setTerm(event.target.value)}/></label>
      <label>Categoria <select value={category} onChange={event => setCategory(event.target.value)}>
        <option value="">Todas</option>
        {categories.map(option => <option key={option}>{option}</option>)}
      </select></label>
      <button type="button" className="secondary" disabled={!term && !category}
        onClick={() => { setTerm(''); setCategory('') }}>Limpar filtros</button>
    </div>
    {!visible.length && <p role="status">Nenhum relatório encontrado para os filtros atuais.</p>}
    <ul className="report-center">
      {visible.map(report => <li key={report.module}>
        <h2>{report.title}</h2>
        <p>{report.detail}</p>
        <button type="button" className="secondary" onClick={() => {
          if (report.module === 'dashboard') setPreview(true)
          else onNavigate(report.module)
        }}>{report.module === 'dashboard' ? 'Visualizar relatório' : 'Abrir consulta'}<span className="sr-only"> {report.title}</span></button>
      </li>)}
    </ul>
  </section>
}
