import { expect, test } from 'vitest'
import { canNavigate } from '../src/layouts/AppShell'
import { filterPayload, panelSections, type Panels } from '../src/features/panels/panelData'

const data: Panels = {
  from_day: '2026-11-01', to_day: '2026-11-27', today: '2026-11-27',
  production: {
    plan: { orders: 2, planned_kg: '50', produced_kg: '39', attainment_pct: '78.0', batches_planned: 5, batches_done: 4, complete: 1, on_time: 0, late: 1 },
    finished_batches: 4, finished_kg: '39', yield_pct: '95.0', lead_hours: '3.5',
    daily: [{ day: '2026-11-26', planned_kg: '30', produced_kg: '0' }],
    orders_due: [{ production_number: 7001, recipe_name: 'TALHARIM', customer_name: 'Cantina A', delivery_date: '2026-11-26', batches_count: 3, done: 2, planned_kg: '30', produced_kg: '19', late: true }],
    by_recipe: [{ recipe_name: 'TALHARIM', batches: 2, planned_kg: '20', actual_kg: '19', measured: 2, yield_pct: '95.0', loss_kg: '1', lead_hours: '4.0' }],
    by_stage: [{ stage: 'PREPARACAO', completed: 2, operators: 2, avg_minutes: '75.0', median_minutes: '75.0', avg_pause_minutes: '15.0', kg_per_hour: '8.0' }],
  },
  stock: null, quality: null,
  commercial: { orders: 2, ordered_kg: '50', shipped: 1, partial: 0, open: 1, overdue: 1, shipments: 1, billed_amount: '450.5',
    customers: [{ customer_name: 'Cantina A', orders: 1, kg: '30', amount: '450.5' }] },
}

test('seções dos painéis para tela, PDF, Excel e impressão', () => {
  const production = panelSections('production', data)
  expect(production.map(s => s.title)).toEqual(['Planejado x realizado', 'Planejado x realizado por dia', 'Produtividade por etapa', 'Rendimento por receita', 'Ordens com entrega no período'])
  expect(production[0]!.rows).toContainEqual(['Atendimento do planejado', '78%'])
  expect(production[2]!.rows[0]).toEqual(['Preparação', 2, 2, '75 min', '75 min', '15 min', '8'])
  expect(production[4]!.rows[0]!.at(-1)).toBe('Atrasada')
  expect(panelSections('commercial', data)[1]!.rows[0]).toEqual(['Cantina A', 1, '30 kg', 'R$ 450,50'])
  expect(panelSections('stock', data)).toEqual([])
})

test('filtros vazios não vão ao servidor; módulo liberado aos três perfis', () => {
  expect(filterPayload({ recipe: 'TALHARIM', customer: '', classification: '' })).toEqual({ recipe: 'TALHARIM' })
  for (const role of ['ADMINISTRADOR', 'PRODUCAO', 'VENDAS']) expect(canNavigate('panels', role)).toBe(true)
})
