import { useSyncExternalStore } from 'react'
import type { RouteAction } from './routes'

/**
 * Favoritos e acessos recentes por usuário. Guardam apenas identificadores de módulos e ações,
 * nunca dados de clientes, receitas ou pedidos. As permissões são revalidadas ao exibir.
 */
type Prefs = { favorites: string[]; recents: string[]; closedDepartments: string[] }
const empty: Prefs = { favorites: [], recents: [], closedDepartments: [] }
const listeners = new Set<() => void>()
const cache = new Map<string, Prefs>()
const keyFor = (user: string) => 'purezza:workspace:' + user
const valid = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z-]{1,40}(:[a-z]{2,20})?$|^[A-Za-zÀ-ú ]{2,40}$/.test(value)

export function readPrefs(user: string): Prefs {
  const hit = cache.get(user)
  if (hit) return hit
  let prefs = empty
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(user)) ?? 'null') as Partial<Prefs> | null
    if (raw) prefs = {
      favorites: (raw.favorites ?? []).filter(valid).slice(0, 12),
      recents: (raw.recents ?? []).filter(valid).slice(0, 8),
      closedDepartments: (raw.closedDepartments ?? []).filter(valid).slice(0, 20),
    }
  } catch { prefs = empty }
  cache.set(user, prefs)
  return prefs
}

function write(user: string, next: Prefs) {
  cache.set(user, next)
  try { localStorage.setItem(keyFor(user), JSON.stringify(next)) } catch { /* armazenamento cheio ou bloqueado: segue só em memória */ }
  listeners.forEach(listener => listener())
}

export function toggleFavorite(user: string, id: string) {
  const prefs = readPrefs(user)
  const favorites = prefs.favorites.includes(id) ? prefs.favorites.filter(item => item !== id) : [...prefs.favorites, id].slice(-12)
  write(user, { ...prefs, favorites })
}

export function pushRecent(user: string, id: string) {
  const prefs = readPrefs(user)
  if (prefs.recents[0] === id) return
  write(user, { ...prefs, recents: [id, ...prefs.recents.filter(item => item !== id)].slice(0, 8) })
}

export function toggleDepartment(user: string, label: string) {
  const prefs = readPrefs(user)
  const closed = prefs.closedDepartments.includes(label)
    ? prefs.closedDepartments.filter(item => item !== label) : [...prefs.closedDepartments, label]
  write(user, { ...prefs, closedDepartments: closed })
}

export function useWorkspacePrefs(user: string) {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => readPrefs(user))
}

export type QuickAction = { id: string; module: string; action?: RouteAction; title: string; hint: string; roles: string[] }

/** Ações rápidas: abrem o formulário certo; a gravação continua exigindo confirmação do usuário. */
export const quickActions: QuickAction[] = [
  { id: 'orders:novo', module: 'orders', action: 'novo', title: 'Novo pedido', hint: 'Abrir formulário de pedido', roles: ['ADMINISTRADOR', 'VENDAS'] },
  { id: 'customers:novo', module: 'customers', action: 'novo', title: 'Novo cliente', hint: 'Cadastrar cliente', roles: ['ADMINISTRADOR', 'VENDAS'] },
  { id: 'production-board', module: 'production-board', title: 'Abrir Kanban', hint: 'Kanban de produção', roles: ['ADMINISTRADOR', 'PRODUCAO', 'VENDAS'] },
  { id: 'inventory:receber', module: 'inventory', action: 'receber', title: 'Receber material', hint: 'Registrar recebimento', roles: ['ADMINISTRADOR', 'PRODUCAO'] },
  { id: 'traceability', module: 'traceability', title: 'Consultar lote', hint: 'Rastreabilidade por código', roles: ['ADMINISTRADOR', 'PRODUCAO'] },
  { id: 'losses:registrar', module: 'losses', action: 'registrar', title: 'Registrar desperdício', hint: 'Perda sem massada', roles: ['ADMINISTRADOR', 'PRODUCAO'] },
  { id: 'products:novo', module: 'products', action: 'novo', title: 'Novo produto', hint: 'Cadastrar produto', roles: ['ADMINISTRADOR'] },
  { id: 'operational-catalog:novo', module: 'operational-catalog', action: 'novo', title: 'Novo fornecedor', hint: 'Cadastros operacionais', roles: ['ADMINISTRADOR'] },
  { id: 'orders', module: 'orders', title: 'Consultar pedidos', hint: 'Lista de pedidos', roles: ['VENDAS'] },
  { id: 'shipping', module: 'shipping', title: 'Expedição', hint: 'Fila de expedição', roles: ['VENDAS'] },
  { id: 'profiles', module: 'profiles', title: 'Usuários', hint: 'Usuários e permissões', roles: ['ADMINISTRADOR'] },
]

export const actionsFor = (role: string) => quickActions.filter(action => action.roles.includes(role))
