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
