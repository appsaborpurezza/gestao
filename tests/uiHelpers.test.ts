import { expect, test } from 'vitest'
import { highlightParts, matchesTerm, normalizeText } from '../src/lib/text'
import { resolvePeriod } from '../src/lib/periods'

test('pesquisa ignora acentos, caixa e ordem das palavras', () => {
  expect(normalizeText('  Ação ÓLEO ')).toBe('acao oleo')
  expect(matchesTerm('oleo soja', 'INS-OLEO', 'Óleo de soja (teste)')).toBe(true)
  expect(matchesTerm('soja ins-ole', 'INS-OLEO', 'Óleo de soja')).toBe(true)
  expect(matchesTerm('farinha', 'INS-OLEO', 'Óleo de soja')).toBe(false)
  expect(matchesTerm('', 'qualquer')).toBe(true)
})

test('destaca o trecho encontrado preservando o texto original', () => {
  expect(highlightParts('Óleo de soja', 'oleo')).toEqual([{ text: 'Óleo', match: true }, { text: ' de soja', match: false }])
  expect(highlightParts('HML-001', '')).toEqual([{ text: 'HML-001', match: false }])
})

test('presets de período incluindo últimos 7 e 30 dias', () => {
  expect(resolvePeriod('last7', '2026-11-27')).toEqual({ from: '2026-11-21', to: '2026-11-27' })
  expect(resolvePeriod('last30', '2026-11-27')).toEqual({ from: '2026-10-29', to: '2026-11-27' })
  expect(resolvePeriod('previousMonth', '2026-03-15')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
})

import { customerSearchFilter } from '../src/features/customers/Customers'
test('filtro de clientes neutraliza caracteres da sintaxe do PostgREST', () => {
  expect(customerSearchFilter('  ')).toBeNull()
  expect(customerSearchFilter('Bella, (x)')).toBe('search_text.ilike.%bella x%')
  expect(customerSearchFilter('São JOÃO')).toBe('search_text.ilike.%sao joao%')
  expect(customerSearchFilter('12.345')).toContain('document.ilike.%12345%')
  expect(customerSearchFilter('42')).toContain('customer_number.eq.42')
  expect(customerSearchFilter('50%_')).toContain('%50\\%\\_%')
})

import { deadlineState } from '../src/features/orders/Orders'
test('situação do prazo do pedido separa atraso de proximidade', () => {
  const today = '2026-11-27'
  expect(deadlineState({ delivery_date: '2026-11-26', fulfillment_status: 'CONFIRMADO' }, today)).toBe('late')
  expect(deadlineState({ delivery_date: '2026-11-29', fulfillment_status: 'PARCIAL' }, today)).toBe('soon')
  expect(deadlineState({ delivery_date: '2026-12-10', fulfillment_status: 'CONFIRMADO' }, today)).toBe('ok')
  expect(deadlineState({ delivery_date: '2026-11-01', fulfillment_status: 'EXPEDIDO' }, today)).toBeNull()
  expect(deadlineState({ delivery_date: '2026-11-01', fulfillment_status: 'RASCUNHO' }, today)).toBeNull()
})
