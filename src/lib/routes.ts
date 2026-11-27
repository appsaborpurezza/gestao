import { useCallback, useEffect, useState } from 'react'

/** `action` abre um formulário do módulo, ex.: `#/orders/novo`. Nunca executa alterações sozinho. */
export type Route = { module: string; recordId: string | null; action?: RouteAction }
export const routeActions = ['novo', 'receber', 'registrar'] as const
export type RouteAction = typeof routeActions[number]

const defaultModule = 'dashboard'
const modulePattern = /^[a-z][a-z-]{1,40}$/
const recordPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Lê rotas no formato `#/modulo` ou `#/modulo/<uuid>`. Fragmentos de autenticação do Supabase são ignorados. */
export function parseRoute(hash: string): Route {
  if (!hash.startsWith('#/')) return { module: defaultModule, recordId: null }
  const [module = '', record = ''] = hash.slice(2).split('/')
  if (!modulePattern.test(module)) return { module: defaultModule, recordId: null }
  if ((routeActions as readonly string[]).includes(record)) return { module, recordId: null, action: record as RouteAction }
  return { module, recordId: recordPattern.test(record) ? record.toLowerCase() : null }
}

export function formatRoute({ module, recordId, action }: Route) {
  return `#/${module}${recordId ? `/${recordId}` : action ? `/${action}` : ''}`
}

/** Navegação por hash, compatível com GitHub Pages: voltar, avançar, atualizar e link direto. */
export function useHashRoute() {
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  useEffect(() => {
    const sync = () => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])
  const navigate = useCallback((next: Route) => {
    const hash = formatRoute(next)
    if (location.hash === hash) return
    history.pushState(null, '', hash)
    setRoute(next)
  }, [])
  return [route, navigate] as const
}
