import { expect, test } from 'vitest'
import { dashboardPeriod } from '../src/features/dashboard/dashboardPeriods'

test('atalhos semanais respeitam segunda-feira e a virada do ano', () => {
  expect(dashboardPeriod('week', '2027-01-01')).toEqual({ from: '2026-12-28', to: '2027-01-01' })
  expect(dashboardPeriod('previousWeek', '2027-01-04')).toEqual({ from: '2026-12-28', to: '2027-01-03' })
  expect(dashboardPeriod('yesterday', '2027-01-01')).toEqual({ from: '2026-12-31', to: '2026-12-31' })
})

test('atalhos mensais respeitam fevereiro bissexto e virada de ano', () => {
  expect(dashboardPeriod('previousMonth', '2028-03-01')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  expect(dashboardPeriod('previousMonth', '2027-01-10')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  expect(dashboardPeriod('year', '2027-10-10')).toEqual({ from: '2027-01-01', to: '2027-10-10' })
})
