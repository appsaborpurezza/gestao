import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RecordSearch, type RecordMatch } from './RecordSearch'

const departments = [
  { label: 'Principal', entries: [['dashboard', 'Indicadores']] },
  { label: 'Comercial', entries: [['orders', 'Pedidos'], ['customers', 'Clientes']] },
  { label: 'Planejamento e produção', entries: [['production-demand', 'Demanda de produção'], ['production-board', 'Kanban de produção'], ['recipes', 'Receitas']] },
  { label: 'Estoque e logística', entries: [['inventory', 'Estoque'], ['shipping', 'Expedição']] },
  { label: 'Qualidade', entries: [['traceability', 'Rastreabilidade'], ['recall', 'Recolhimentos'], ['losses', 'Desperdícios']] },
  { label: 'Cadastros', entries: [['products', 'Produtos'], ['operational-catalog', 'Cadastros operacionais'], ['recipe-assignments', 'Associações de receitas'], ['import', 'Importação']] },
]
const operational = new Set(['production-demand', 'recipes', 'inventory', 'traceability', 'recall', 'losses'])
const commercial = new Set(['orders', 'customers'])
const administrative = new Set(['operational-catalog', 'recipe-assignments', 'import'])
const shared = new Set(['dashboard', 'products', 'production-board', 'shipping'])

export function canNavigate(id: string, role: string) {
  if (role !== 'ADMINISTRADOR' && role !== 'VENDAS' && role !== 'PRODUCAO') return false
  if (administrative.has(id)) return role === 'ADMINISTRADOR'
  if (operational.has(id)) return role !== 'VENDAS'
  if (commercial.has(id)) return role !== 'PRODUCAO'
  return shared.has(id)
}

const roleLabels: Record<string, string> = {
  ADMINISTRADOR: 'Administração', PRODUCAO: 'Produção', VENDAS: 'Vendas',
}

export function AppShell({ active, name, role, accountScope, onNavigate, onOpenRecord, onSignOut, children }: {
  active: string
  name?: string
  role?: string
  accountScope: string
  onNavigate: (id: string) => void
  onOpenRecord: (record: RecordMatch) => void
  onSignOut: () => Promise<void>
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState(false)
  const drawer = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLDialogElement>(null)
  const [term, setTerm] = useState('')
  const current = departments.find(group => group.entries.some(([id]) => id === active))
  const label = current?.entries.find(([id]) => id === active)?.[1]

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  useEffect(() => {
    if (!role) return
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        drawer.current?.close()
        if (!search.current?.open) search.current?.showModal()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [role])

  const normalize = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  const matching = role ? departments.flatMap(group => group.entries.filter(([id, title]) =>
    canNavigate(id!, role) && normalize(title!).includes(normalize(term.trim())))) : []

  const navigation = role && <nav aria-label="Módulos">
    {departments.map(({ label: department, entries }) => {
      const visible = entries.filter(([id]) => canNavigate(id!, role))
      if (!visible.length) return null
      return <section key={department}>
        <h2>{department}</h2>
        {visible.map(([id, title]) => <button type="button" key={id} aria-current={active === id ? 'page' : undefined}
          onClick={() => { drawer.current?.close(); onNavigate(id!) }}>{title}</button>)}
      </section>
    })}
  </nav>

  return <div className="app-shell" data-collapsed={collapsed}>
    <a className="shell-skip" href="#conteudo">Pular para o conteúdo</a>
    <header className="shell-header">
      {role && <>
        <button type="button" className="secondary shell-desktop-control" aria-controls="desktop-modules"
          aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? 'Abrir menu' : 'Recolher menu'}</button>
        <button type="button" className="secondary shell-mobile-control" aria-haspopup="dialog" onClick={() => drawer.current?.showModal()}>Menu</button>
      </>}
      <img className="shell-logo" src={import.meta.env.BASE_URL + 'logo.png'} alt="Sabor Purezza Massas" width={44} height={44}/>
      <strong>Sabor Purezza SMART</strong>
      {role && <button type="button" className="secondary shell-search-control" aria-haspopup="dialog"
        onClick={() => search.current?.showModal()}>Buscar <kbd>Ctrl+K</kbd></button>}
      <span className="shell-connection" role="status">{online ? 'Rede disponível' : 'Sem conexão'}</span>
      {name && <div className="shell-user"><strong>{name}</strong><small>{roleLabels[role ?? '']}</small></div>}
      <button type="button" className="secondary" disabled={signingOut} onClick={async () => {
        setSigningOut(true)
        setSignOutError(false)
        try { await onSignOut() } catch { setSignOutError(true) } finally { setSigningOut(false) }
      }}>{signingOut ? 'Saindo…' : 'Sair'}</button>
    </header>
    {role && <aside id="desktop-modules" className="shell-sidebar" hidden={collapsed}>{navigation}</aside>}
    <dialog ref={drawer} className="shell-drawer" aria-label="Menu de módulos">
      <button type="button" className="secondary" onClick={() => drawer.current?.close()}>Fechar menu</button>
      {navigation}
    </dialog>
    <dialog ref={search} className="shell-search" aria-label="Busca global" onClose={() => setTerm('')}>
      <label>Buscar módulos e registros <input type="search" maxLength={100} autoFocus value={term} onChange={event => setTerm(event.target.value)} /></label>
      <h3>Módulos</h3>
      {matching.length ? <ul>{matching.map(([id, title]) => <li key={id}>
        <button type="button" className="secondary" onClick={() => { search.current?.close(); onNavigate(id!) }}>{title}</button>
      </li>)}</ul> : <p role="status">Nenhum módulo encontrado.</p>}
      {role && <RecordSearch term={term} accountScope={accountScope} onOpen={record => {
        if (!canNavigate(record.module, role)) return
        search.current?.close()
        onOpenRecord(record)
      }}/>}
      <button type="button" className="secondary" onClick={() => search.current?.close()}>Fechar busca</button>
    </dialog>
    <main id="conteudo" tabIndex={-1} className="workspace shell-content">
      {role && current && <p className="shell-breadcrumb" aria-label="Localização">{current.label} / {label}</p>}
      {signOutError && <p role="alert">Falha ao sair. Tente novamente.</p>}
      {children}
    </main>
  </div>
}
