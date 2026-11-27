import { expect, test } from 'vitest'
import { formatRoute, parseRoute } from '../src/lib/routes'
import { departments, canNavigate } from '../src/layouts/navigation'
import { authMessage } from '../src/features/auth/authMessages'

const id = '3f1c2b9e-8a4d-4c1e-9b2a-1d2e3f4a5b6c'

test('lê e formata rotas por hash', () => {
  expect(parseRoute('')).toEqual({ module: 'dashboard', recordId: null })
  expect(parseRoute('#/orders')).toEqual({ module: 'orders', recordId: null })
  expect(parseRoute(`#/customers/${id.toUpperCase()}`)).toEqual({ module: 'customers', recordId: id })
  expect(formatRoute({ module: 'customers', recordId: id })).toBe(`#/customers/${id}`)
  expect(formatRoute({ module: 'orders', recordId: null })).toBe('#/orders')
})

test('ignora fragmentos de autenticação e valores inválidos', () => {
  expect(parseRoute('#access_token=abc&type=recovery')).toEqual({ module: 'dashboard', recordId: null })
  expect(parseRoute('#/ORDERS')).toEqual({ module: 'dashboard', recordId: null })
  expect(parseRoute('#/orders/nao-e-uuid')).toEqual({ module: 'orders', recordId: null })
  expect(parseRoute('#/orders/<script>')).toEqual({ module: 'orders', recordId: null })
})

test('todo item de menu aponta para um módulo acessível a algum perfil', () => {
  const ids = departments.flatMap(group => group.entries.map(entry => entry.id))
  expect(new Set(ids).size).toBe(ids.length)
  for (const module of ids) expect(['ADMINISTRADOR', 'VENDAS', 'PRODUCAO'].some(role => canNavigate(module, role))).toBe(true)
})

test('mensagens de autenticação em português sem revelar contas', () => {
  expect(authMessage('Invalid login credentials')).toBe('E-mail ou senha incorretos.')
  expect(authMessage('Email rate limit exceeded')).toMatch(/Muitas tentativas/)
  expect(authMessage('User not found')).not.toMatch(/not found|não encontrado/i)
})
