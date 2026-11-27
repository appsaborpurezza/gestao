import { expect, test } from 'vitest'
import { previousPeriod, trend } from '../src/features/dashboard/trend'

test('período anterior com o mesmo tamanho', () => {
  expect(previousPeriod({ from: '2026-11-01', to: '2026-11-30' })).toEqual({ from: '2026-10-02', to: '2026-10-31' })
  expect(previousPeriod({ from: '2026-11-27', to: '2026-11-27' })).toEqual({ from: '2026-11-26', to: '2026-11-26' })
  expect(previousPeriod({ from: '2026-03-01', to: '2026-03-07' })).toEqual({ from: '2026-02-22', to: '2026-02-28' })
})

test('tendência percentual e em pontos', () => {
  expect(trend(120, 100)).toEqual({ direction: 'up', label: '+20%' })
  expect(trend('80', '100')).toEqual({ direction: 'down', label: '−20%' })
  expect(trend(5, 0)).toBeNull()
  expect(trend(0, 0)).toEqual({ direction: 'flat', label: 'Estável' })
  expect(trend(null, 10)).toBeNull()
  expect(trend('92.5', '90', 'points')).toEqual({ direction: 'up', label: '+2,5 p.p.' })
})
