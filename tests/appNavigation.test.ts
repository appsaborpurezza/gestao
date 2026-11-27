import { expect, test } from 'vitest'
import { canNavigate } from '../src/layouts/AppShell'

test('mantém os módulos comerciais e operacionais nos perfis autorizados', () => {
  expect(canNavigate('orders', 'PRODUCAO')).toBe(false)
  expect(canNavigate('customers', 'VENDAS')).toBe(true)
  expect(canNavigate('recipes', 'VENDAS')).toBe(false)
  expect(canNavigate('inventory', 'PRODUCAO')).toBe(true)
  expect(canNavigate('shipping', 'VENDAS')).toBe(true)
  expect(canNavigate('production-board', 'VENDAS')).toBe(true)
  expect(canNavigate('recipe-assignments', 'PRODUCAO')).toBe(false)
  expect(canNavigate('import', 'VENDAS')).toBe(false)
  expect(canNavigate('import', 'ADMINISTRADOR')).toBe(true)
  expect(canNavigate('dashboard', 'DESCONHECIDO')).toBe(false)
  expect(canNavigate('modulo-inexistente', 'ADMINISTRADOR')).toBe(false)
})
