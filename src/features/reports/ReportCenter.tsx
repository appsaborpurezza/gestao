import { lazy, Suspense, useState } from 'react'
import { canNavigate } from '../../layouts/AppShell'
import { ArrowLeft, FileBarChart, SearchX } from 'lucide-react'
import { Badge, EmptyState, PageHeader } from '../../ui'
import { FilterBar, SearchInput } from '../../ui/filters'

const Dashboard = lazy(() => import('../dashboard/Dashboard'))
type Report = { category: string; title: string; detail: string; module: string; panel?: string; technical?: boolean; commercial?: boolean }
const reports: Report[] = [
  { category: 'Indicadores', title: 'Indicadores por período', detail: 'Produção, perdas e indicadores comerciais conforme o perfil. Exportação em PDF e Excel.', module: 'dashboard' },
  { category: 'Produção', title: 'Painel de produção', detail: 'Planejado x realizado, rendimento por receita, produtividade e tempos por etapa. PDF, Excel e impressão.', module: 'panels', panel: 'production', technical: true },
  { category: 'Estoque', title: 'Painel de estoque', detail: 'Saldo atual por situação, classificação e validade. PDF, Excel e impressão.', module: 'panels', panel: 'stock', technical: true },
  { category: 'Qualidade', title: 'Painel de qualidade', detail: 'Perdas por motivo, destino e operação, peso abaixo do nominal e recolhimentos. PDF, Excel e impressão.', module: 'panels', panel: 'quality', technical: true },
  { category: 'Comercial', title: 'Painel comercial', detail: 'Pedidos, expedições e faturamento por cliente. PDF, Excel e impressão.', module: 'panels', panel: 'commercial', commercial: true },
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
  const allowed = reports.filter(report => canNavigate(report.module, role)
    && !(report.technical && role === 'VENDAS') && !(report.commercial && role === 'PRODUCAO'))
  const openPanel = (panel: string) => {
    const key = 'purezza:filters:panels:' + accountScope
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, unknown>
      sessionStorage.setItem(key, JSON.stringify({ ...saved, panel }))
    } catch { /* armazenamento indisponível: abre no primeiro painel */ }
    onNavigate('panels')
  }
  const categories = [...new Set(allowed.map(report => report.category))]
  const needle = searchKey(term.trim())
  const visible = allowed.filter(report => (!category || report.category === category)
    && searchKey(`${report.title} ${report.detail}`).includes(needle))
  if (preview) return <>
    <button type="button" className="secondary" onClick={() => setPreview(false)}><ArrowLeft aria-hidden="true" size={16}/>Voltar à central de relatórios</button>
    <Suspense fallback={<p role="status">Abrindo relatório…</p>}>
      <Dashboard accessKey={accountScope} onNavigate={onNavigate}/>
    </Suspense>
  </>
  return <section className="panel">
    <PageHeader icon={FileBarChart} title="Central de relatórios" description="Consultas e relatórios disponíveis para o seu perfil."/>
    <FilterBar activeCount={[term, category].filter(Boolean).length} onClear={() => { setTerm(''); setCategory('') }}>
      <SearchInput label="Buscar relatório" value={term} onChange={setTerm}/>
      <label>Categoria <select value={category} onChange={event => setCategory(event.target.value)}>
        <option value="">Todas</option>
        {categories.map(option => <option key={option}>{option}</option>)}
      </select></label>
    </FilterBar>
    {!visible.length && <EmptyState icon={SearchX} title="Nenhum relatório encontrado" description="Ajuste a busca ou a categoria."/>}
    <ul className="report-center">
      {visible.map(report => <li key={report.title}>
        <Badge tone="info">{report.category}</Badge>
        <h2>{report.title}</h2>
        <p>{report.detail}</p>
        <button type="button" className="secondary" onClick={() => {
          if (report.module === 'dashboard') setPreview(true)
          else if (report.panel) openPanel(report.panel)
          else onNavigate(report.module)
        }}>{report.module === 'dashboard' || report.panel ? 'Visualizar relatório' : 'Abrir consulta'}<span className="sr-only"> {report.title}</span></button>
      </li>)}
    </ul>
  </section>
}
