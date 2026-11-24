import { expect, test } from 'vitest'
import { dashboardPreferences, defaultDashboardPreferences } from '../src/features/dashboard/dashboardPreferences'

const today = '2026-11-24'
const key = 'purezza:indicators:account:role'

test('restaura o período consultado e o agrupamento da conta e do perfil', () => {
  const saved = { from: '2026-10-01', to: '2026-10-31', grouping: 'week' }
  const storage = { getItem: (name: string) => name === key ? JSON.stringify(saved) : null }
  expect(dashboardPreferences(storage, key, today)).toEqual(saved)
  expect(dashboardPreferences(storage, 'outra-conta', today)).toEqual(defaultDashboardPreferences(today))
})

test('usa o mês corrente quando a preferência está inválida ou inacessível', () => {
  for (const stored of ['{', '{"from":"2026-02-30","to":"2026-11-01","grouping":"day"}',
    '{"from":"2026-11-01","to":"2026-12-01","grouping":"month"}',
    '{"from":"2026-11-02","to":"2026-11-01","grouping":"day"}',
    '{"from":"2026-11-01","to":"2026-11-02","grouping":"hour"}']) {
    expect(dashboardPreferences({ getItem: () => stored }, key, today)).toEqual(defaultDashboardPreferences(today))
  }
  expect(dashboardPreferences({ getItem: () => { throw new Error('denied') } }, key, today))
    .toEqual({ from: '2026-11-01', to: today, grouping: 'day' })
})
