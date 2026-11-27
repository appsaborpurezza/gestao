import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Bell, ChevronsLeft, ChevronsRight, LogOut, Menu, Search, Wifi, WifiOff, X } from 'lucide-react'
import { RecordSearch, type RecordMatch } from './RecordSearch'
import { canNavigate, departments, findEntry, roleLabels } from './navigation'

export { canNavigate } from './navigation'

const collapseKey = 'purezza:sidebar-collapsed'
const compactQuery = '(max-width: 1180px)'
const logo = (size: 64 | 128) => import.meta.env.BASE_URL + (size === 64 ? 'logo-64.png' : 'logo-128.webp')

function initials(name?: string) {
  return (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || '?'
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
  const [preferCollapsed, setCollapsed] = useState(() => localStorage.getItem(collapseKey) === '1')
  // Em tablets (até 1180 px) a sidebar fica compacta para liberar área de operação.
  const [compactScreen, setCompactScreen] = useState(() => window.matchMedia(compactQuery).matches)
  useEffect(() => {
    const media = window.matchMedia(compactQuery)
    const update = () => setCompactScreen(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const [expandedOnTablet, setExpandedOnTablet] = useState(false)
  const collapsed = compactScreen ? !expandedOnTablet : preferCollapsed
  const [online, setOnline] = useState(() => navigator.onLine)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState(false)
  const [userMenu, setUserMenu] = useState(false)
  const drawer = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLDialogElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const [term, setTerm] = useState('')
  const current = findEntry(active)

  useEffect(() => { localStorage.setItem(collapseKey, preferCollapsed ? '1' : '0') }, [preferCollapsed])

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

  useEffect(() => {
    if (!userMenu) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !userMenuRef.current?.contains(event.target as Node)) setUserMenu(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [userMenu])

  async function signOut() {
    setSigningOut(true)
    setSignOutError(false)
    try { await onSignOut() } catch { setSignOutError(true) } finally { setSigningOut(false) }
  }

  const normalize = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  const matching = role ? departments.flatMap(group => group.entries.filter(entry =>
    canNavigate(entry.id, role) && normalize(entry.title).includes(normalize(term.trim())))) : []

  const navigation = (compact: boolean) => role && <nav aria-label="Módulos">
    {departments.map(department => {
      const visible = department.entries.filter(entry => canNavigate(entry.id, role))
      if (!visible.length) return null
      return <section key={department.label}>
        <h2 className={compact ? 'sr-only' : undefined}>{department.label}</h2>
        {visible.map(({ id, title, icon: Icon }) => <button type="button" key={id} aria-current={active === id ? 'page' : undefined}
          title={compact ? title : undefined} aria-label={compact ? title : undefined}
          onClick={() => { drawer.current?.close(); setExpandedOnTablet(false); onNavigate(id) }}>
          <Icon aria-hidden="true" size={18}/><span className={compact ? 'sr-only' : undefined}>{title}</span>
        </button>)}
      </section>
    })}
  </nav>

  return <div className="app-shell" data-collapsed={collapsed}>
    <a className="shell-skip" href="#conteudo" onClick={event => {
      event.preventDefault()
      document.getElementById('conteudo')?.focus()
    }}>Pular para o conteúdo</a>

    {role && <aside id="desktop-modules" className="shell-sidebar" aria-label="Navegação principal">
      <div className="shell-brand">
        <img src={logo(64)} alt="" width={40} height={40}/>
        <span className={collapsed ? 'sr-only' : undefined}><strong>Sabor Purezza</strong><small>SMART</small></span>
      </div>
      {navigation(collapsed)}
      <button type="button" className="shell-collapse" aria-controls="desktop-modules" aria-expanded={!collapsed}
        onClick={() => compactScreen ? setExpandedOnTablet(value => !value) : setCollapsed(value => !value)}>
        {collapsed ? <ChevronsRight aria-hidden="true" size={18}/> : <ChevronsLeft aria-hidden="true" size={18}/>}
        <span className={collapsed ? 'sr-only' : undefined}>{collapsed ? 'Expandir menu' : 'Recolher menu'}</span>
      </button>
    </aside>}

    <header className="shell-header">
      {role && <button type="button" className="icon-button shell-mobile-control" aria-haspopup="dialog" aria-label="Abrir menu"
        onClick={() => drawer.current?.showModal()}><Menu aria-hidden="true" size={20}/></button>}
      <div className="shell-heading">
        {current
          ? <nav aria-label="Localização" className="shell-breadcrumb"><span>{current.department.label}</span><span aria-hidden="true">/</span><strong aria-current="page">{current.entry.title}</strong></nav>
          : <strong>Sabor Purezza SMART</strong>}
      </div>
      {role && <button type="button" className="shell-search-control" aria-haspopup="dialog"
        onClick={() => search.current?.showModal()}>
        <Search aria-hidden="true" size={16}/><span>Buscar módulos e registros</span><kbd>Ctrl K</kbd>
      </button>}
      <span className="shell-connection" data-online={online} role="status" title={online ? 'Conectado' : 'Sem conexão'}>
        {online ? <Wifi aria-hidden="true" size={16}/> : <WifiOff aria-hidden="true" size={16}/>}
        <span>{online ? 'Conectado' : 'Sem conexão'}</span>
      </span>
      {role && canNavigate('alerts', role) && <button type="button" className="icon-button" aria-label="Central de alertas"
        aria-current={active === 'alerts' ? 'page' : undefined} onClick={() => onNavigate('alerts')}>
        <Bell aria-hidden="true" size={20}/>
      </button>}
      <div className="shell-user" ref={userMenuRef}>
        <button type="button" className="shell-user-trigger" aria-haspopup="menu" aria-expanded={userMenu}
          onClick={() => setUserMenu(value => !value)}>
          <span className="shell-avatar" aria-hidden="true">{initials(name)}</span>
          <span className="shell-user-label"><strong>{name ?? 'Conta'}</strong><small>{roleLabels[role ?? ''] ?? 'Sem perfil'}</small></span>
        </button>
        {userMenu && <div className="shell-user-menu" role="menu">
          <p><strong>{name ?? 'Conta'}</strong><br/><small>{roleLabels[role ?? ''] ?? 'Sem perfil ativo'}</small></p>
          <button type="button" role="menuitem" disabled={signingOut} onClick={() => void signOut()}>
            <LogOut aria-hidden="true" size={16}/>{signingOut ? 'Saindo…' : 'Sair'}
          </button>
        </div>}
      </div>
    </header>

    <dialog ref={drawer} className="shell-drawer" aria-label="Menu de módulos">
      <div className="shell-drawer-head">
        <div className="shell-brand"><img src={logo(64)} alt="" width={36} height={36}/><span><strong>Sabor Purezza</strong><small>SMART</small></span></div>
        <button type="button" className="icon-button" aria-label="Fechar menu" onClick={() => drawer.current?.close()}><X aria-hidden="true" size={20}/></button>
      </div>
      {navigation(false)}
    </dialog>

    <dialog ref={search} className="shell-search" aria-label="Busca global" onClose={() => setTerm('')}>
      <div className="shell-search-field">
        <Search aria-hidden="true" size={18}/>
        <input type="search" aria-label="Buscar módulos e registros" placeholder="Buscar módulos e registros"
          maxLength={100} autoFocus value={term} onChange={event => setTerm(event.target.value)}/>
        <button type="button" className="icon-button" aria-label="Fechar busca" onClick={() => search.current?.close()}><X aria-hidden="true" size={18}/></button>
      </div>
      <h3>Módulos</h3>
      {matching.length ? <ul>{matching.map(({ id, title, icon: Icon }) => <li key={id}>
        <button type="button" className="secondary" onClick={() => { search.current?.close(); onNavigate(id) }}>
          <Icon aria-hidden="true" size={16}/>{title}
        </button>
      </li>)}</ul> : <p role="status">Nenhum módulo encontrado.</p>}
      {role && <RecordSearch term={term} accountScope={accountScope} onOpen={record => {
        if (!canNavigate(record.module, role)) return
        search.current?.close()
        onOpenRecord(record)
      }}/>}
    </dialog>

    <main id="conteudo" tabIndex={-1} className="shell-content">
      {signOutError && <p role="alert">Falha ao sair. Tente novamente.</p>}
      {children}
    </main>
  </div>
}
