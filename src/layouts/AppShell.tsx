import { useEffect, useRef, useState, type ReactNode } from 'react'
import { HelpCircle, Bell, ChevronDown, ChevronsLeft, ChevronsRight, Clock3, LogOut, Menu, Search, Star, Wifi, WifiOff, X, Zap } from 'lucide-react'
import { RecordSearch, type RecordMatch } from './RecordSearch'
import { canNavigate, departments, findEntry, roleLabels, type NavEntry } from './navigation'
import { actionsFor, pushRecent, setWorkspaceUser, toggleDepartment, toggleFavorite, useWorkspacePrefs, type QuickAction } from '../lib/workspace'
import { highlightParts, normalizeText } from '../lib/text'
import { HelpCenter, openHelp } from '../ui/Help'

function Marked({ text, term }: { text: string; term: string }) {
  return <>{highlightParts(text, term).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</>
}

/** Setas, Home e End percorrem os itens da paleta; Enter abre. */
function paletteKeys(event: React.KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-palette]')]
  if (!items.length) return
  event.preventDefault()
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : event.key === 'ArrowDown' ? Math.min(index + 1, items.length - 1) : index <= 0 ? -1 : index - 1
  if (next < 0) event.currentTarget.querySelector<HTMLInputElement>('input')?.focus()
  else items[next]?.focus()
}

export { canNavigate } from './navigation'

const collapseKey = 'purezza:sidebar-collapsed'
const compactQuery = '(max-width: 1180px)'
const logo = (size: 64 | 128) => import.meta.env.BASE_URL + (size === 64 ? 'logo-64.png' : 'logo-128.webp')

function initials(name?: string) {
  return (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || '?'
}

export function AppShell({ active, name, role, accountScope, onNavigate, onAction, onOpenRecord, onSignOut, children }: {
  active: string
  name?: string
  role?: string
  accountScope: string
  onNavigate: (id: string) => void
  onAction?: (action: QuickAction) => void
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
  const user = accountScope.split(':')[0] ?? 'anon'
  setWorkspaceUser(user)
  const prefs = useWorkspacePrefs(user)
  const allowed = (id: string) => !!role && canNavigate(id, role)
  const favorite = prefs.favorites.includes(active)
  useEffect(() => { if (role && canNavigate(active, role)) pushRecent(user, active) }, [active, role, user])

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

  const needle = normalizeText(term)
  const matching = role ? departments.flatMap(group => group.entries.filter(entry =>
    canNavigate(entry.id, role) && normalizeText(entry.title + ' ' + group.label).includes(needle))) : []
  const actions = role ? actionsFor(role).filter(action => canNavigate(action.module, role)
    && normalizeText(action.title + ' ' + action.hint).includes(needle)) : []
  const recents = prefs.recents.filter(id => id !== active && allowed(id)).map(id => findEntry(id)?.entry).filter((entry): entry is NavEntry => !!entry).slice(0, 5)
  const favoriteEntries = prefs.favorites.filter(allowed).map(id => findEntry(id)?.entry).filter((entry): entry is NavEntry => !!entry)
  const runAction = (action: QuickAction) => {
    search.current?.close()
    if (onAction) onAction(action)
    else onNavigate(action.module)
  }
  const go = (id: string) => { drawer.current?.close(); setExpandedOnTablet(false); onNavigate(id) }
  const navButton = (compact: boolean) => ({ id, title, icon: Icon }: NavEntry) => <button type="button" key={id}
    aria-current={active === id ? 'page' : undefined} title={compact ? title : undefined} aria-label={compact ? title : undefined}
    onClick={() => go(id)}>
    <Icon aria-hidden="true" size={18}/><span className={compact ? 'sr-only' : undefined}>{title}</span>
  </button>

  const navigation = (compact: boolean) => role && <nav aria-label="Módulos">
    {favoriteEntries.length > 0 && <section className="shell-favorites">
      <h2 className={compact ? 'sr-only' : undefined}><Star aria-hidden="true" size={12}/> Favoritos</h2>
      {favoriteEntries.map(navButton(compact))}
    </section>}
    {departments.map(department => {
      const visible = department.entries.filter(entry => canNavigate(entry.id, role))
      if (!visible.length) return null
      // Departamento recolhido continua mostrando a página ativa, para não perder a referência.
      const closed = !compact && prefs.closedDepartments.includes(department.label)
      const shown = closed ? visible.filter(entry => entry.id === active) : visible
      const headingId = 'dep-' + normalizeText(department.label).replace(/\W+/g, '-') + (compact ? '-c' : '')
      return <section key={department.label} aria-labelledby={headingId}>
        {compact ? <h2 id={headingId} className="sr-only">{department.label}</h2>
          : <h2 id={headingId}><button type="button" className="shell-department" aria-expanded={!closed}
            onClick={() => toggleDepartment(user, department.label)}>
            {department.label}<ChevronDown aria-hidden="true" size={14}/>
          </button></h2>}
        {shown.map(navButton(compact))}
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
        {current && allowed(active) && <button type="button" className="icon-button shell-favorite" aria-pressed={favorite}
          aria-label={favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'} title={favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
          onClick={() => toggleFavorite(user, active)}>
          <Star aria-hidden="true" size={16} fill={favorite ? 'currentColor' : 'none'}/>
        </button>}
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
          <button type="button" role="menuitem" onClick={() => { setUserMenu(false); openHelp() }}>
            <HelpCircle aria-hidden="true" size={16}/>Dicas e ajuda
          </button>
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

    <dialog ref={search} className="shell-search" aria-label="Busca global" onClose={() => setTerm('')} onKeyDown={paletteKeys}>
      <div className="shell-search-field">
        <Search aria-hidden="true" size={18}/>
        <input type="search" aria-label="Buscar módulos e registros" placeholder="Buscar módulos e registros"
          maxLength={100} autoFocus value={term} onChange={event => setTerm(event.target.value)}/>
        <button type="button" className="icon-button" aria-label="Fechar busca" onClick={() => search.current?.close()}><X aria-hidden="true" size={18}/></button>
      </div>
      {actions.length > 0 && <>
        <h3>Ações</h3>
        <ul>{actions.map(action => <li key={action.id}>
          <button type="button" className="secondary" data-palette onClick={() => runAction(action)}>
            <Zap aria-hidden="true" size={16}/><span><Marked text={action.title} term={term}/></span><small>{action.hint}</small>
          </button>
        </li>)}</ul>
      </>}
      {!needle && recents.length > 0 && <>
        <h3>Recentes</h3>
        <ul>{recents.map(({ id, title }) => <li key={id}>
          <button type="button" className="secondary" data-palette onClick={() => { search.current?.close(); onNavigate(id) }}>
            <Clock3 aria-hidden="true" size={16}/>{title}
          </button>
        </li>)}</ul>
      </>}
      <h3>Módulos</h3>
      {matching.length ? <ul>{matching.map(({ id, title, icon: Icon }) => <li key={id}>
        <button type="button" className="secondary" data-palette onClick={() => { search.current?.close(); onNavigate(id) }}>
          <Icon aria-hidden="true" size={16}/><span><Marked text={title} term={term}/></span>
        </button>
      </li>)}</ul> : <p role="status">Nenhum módulo encontrado.</p>}
      {role && <RecordSearch term={term} accountScope={accountScope} onOpen={record => {
        if (!canNavigate(record.module, role)) return
        search.current?.close()
        onOpenRecord(record)
      }}/>}
    </dialog>

    <HelpCenter role={role}/>
    <main id="conteudo" tabIndex={-1} className="shell-content">
      {signOutError && <p role="alert">Falha ao sair. Tente novamente.</p>}
      {children}
    </main>
  </div>
}
