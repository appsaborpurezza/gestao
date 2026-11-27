import { expect, test } from 'vitest'
import { formatRoute, parseRoute } from '../src/lib/routes'
import { actionsFor, pushRecent, readPrefs, toggleDepartment, toggleFavorite } from '../src/lib/workspace'
import { canNavigate } from '../src/layouts/navigation'

test('rotas de ação abrem formulários sem confundir com registros', () => {
  expect(parseRoute('#/orders/novo')).toEqual({ module: 'orders', recordId: null, action: 'novo' })
  expect(parseRoute('#/inventory/receber')).toEqual({ module: 'inventory', recordId: null, action: 'receber' })
  expect(parseRoute('#/orders/excluir')).toEqual({ module: 'orders', recordId: null })
  expect(formatRoute({ module: 'losses', recordId: null, action: 'registrar' })).toBe('#/losses/registrar')
})

test('ações rápidas respeitam o perfil', () => {
  for (const role of ['ADMINISTRADOR', 'VENDAS', 'PRODUCAO']) {
    const actions = actionsFor(role)
    expect(actions.length).toBeGreaterThan(2)
    for (const action of actions) expect(canNavigate(action.module, role)).toBe(true)
  }
  expect(actionsFor('VENDAS').map(action => action.id)).not.toContain('inventory:receber')
  expect(actionsFor('PRODUCAO').map(action => action.id)).not.toContain('orders:novo')
})

test('favoritos, recentes e departamentos guardam só identificadores, por usuário', () => {
  toggleFavorite('u1', 'production-board')
  toggleFavorite('u1', 'orders')
  toggleFavorite('u1', 'production-board')
  pushRecent('u1', 'orders'); pushRecent('u1', 'inventory'); pushRecent('u1', 'orders')
  toggleDepartment('u1', 'Produção')
  expect(readPrefs('u1')).toEqual({ favorites: ['orders'], recents: ['orders', 'inventory'], closedDepartments: ['Produção'] })
  expect(readPrefs('u2').favorites).toEqual([])
})
