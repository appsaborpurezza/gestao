import { expect, test } from 'vitest'
import { groupProductionSeries, type ProductionDay } from '../src/features/dashboard/productionSeries'

const days: ProductionDay[] = [
  { day: '2026-12-31', finished_count: 1, measured_count: 1, measured_kg: '99999999999.9999999', loss_kg: null },
  { day: '2027-01-01', finished_count: 2, measured_count: 1, measured_kg: '0.0000001', loss_kg: '0.25' },
  { day: '2027-01-04', finished_count: 1, measured_count: 0, measured_kg: null, loss_kg: null },
]

test('agrupa a semana de segunda a domingo mesmo na virada do ano, sem perder precisão', () => {
  expect(groupProductionSeries(days, 'week')).toEqual([
    {
      total: { day: '2026-12-28', finished_count: 3, measured_count: 2, measured_kg: '100000000000.0000000', loss_kg: '0.25' },
      days: days.slice(0, 2),
    },
    { total: days[2], days: [days[2]] },
  ])
})

test('preserva lacunas e respeita os limites de mês', () => {
  expect(groupProductionSeries(days, 'month')).toEqual([
    { total: { ...days[0], day: '2026-12-01' }, days: days.slice(0, 1) },
    { total: { ...days[1], finished_count: 3 }, days: days.slice(1) },
  ])
  expect(groupProductionSeries(days, 'day').map(group => group.total)).toEqual(days)
  expect(groupProductionSeries([], 'week')).toEqual([])
})
