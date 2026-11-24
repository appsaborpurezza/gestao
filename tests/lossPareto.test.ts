import { expect, test } from 'vitest'
import { lossPareto } from '../src/features/dashboard/lossPareto'

test('ordena pelo peso exato e calcula o acumulado antes de arredondar', () => {
  const rows = lossPareto([
    { reason: 'A', kg: '100000000000.000001' },
    { reason: 'B', kg: '100000000000.000002' },
    { reason: 'C', kg: '100000000000.000000' },
  ])
  expect(rows.map(row => [row.reason, row.share.display, row.cumulative])).toEqual([
    ['B', '33,33%', '33,33%'],
    ['A', '33,33%', '66,67%'],
    ['C', '33,33%', '100%'],
  ])
  expect(lossPareto([])).toEqual([])
})
