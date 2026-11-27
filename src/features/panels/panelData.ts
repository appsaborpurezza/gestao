import { formatBrl, formatStockQuantity } from '../../lib/decimal'
import type { IndicatorSection } from '../dashboard/indicatorExport'
import { dateLabel } from '../dashboard/indicatorExport'

export type PanelFilters = { recipe: string; customer: string; classification: string }
export const emptyPanelFilters: PanelFilters = { recipe: '', customer: '', classification: '' }
export type PanelId = 'production' | 'stock' | 'quality' | 'commercial'

type Num = string | null
export type ProductionPanel = {
  plan: { orders: number; planned_kg: Num; produced_kg: Num; attainment_pct: Num; batches_planned: number; batches_done: number; complete: number; on_time: number; late: number }
  finished_batches: number; finished_kg: Num; yield_pct: Num; lead_hours: Num
  daily: { day: string; planned_kg: Num; produced_kg: Num }[]
  orders_due: { production_number: number; recipe_name: string; customer_name: string; delivery_date: string; batches_count: number; done: number; planned_kg: Num; produced_kg: Num; late: boolean }[]
  by_recipe: { recipe_name: string; batches: number; planned_kg: Num; actual_kg: Num; measured: number; yield_pct: Num; loss_kg: Num; lead_hours: Num }[]
  by_stage: { stage: string; completed: number; operators: number; avg_minutes: Num; median_minutes: Num; avg_pause_minutes: Num; kg_per_hour: Num }[]
}
export type StockPanel = {
  lots: number; kg: Num; finished_goods_kg: Num; quarantine: number; blocked: number; expired: number; expiring_7: number; expiring_30: number
  by_status: { status: string; lots: number; kg: Num }[]
  by_classification: { classification: string; lots: number; kg: Num }[]
}
type Share = { name: string; kg: Num }
export type QualityPanel = {
  loss_kg: Num; loss_pct: Num; underweight: number; measured: number; recalls_opened: number; recalls_open: number; pending_release: number
  by_reason: Share[]; by_destination: Share[]; by_operation: Share[]
}
export type CommercialPanel = {
  orders: number; ordered_kg: Num; shipped: number; partial: number; open: number; overdue: number; shipments: number; billed_amount: Num
  customers: { customer_name: string; orders: number; kg: Num; amount: Num }[]
}
export type Panels = {
  from_day: string; to_day: string; today: string
  production: ProductionPanel | null; stock: StockPanel | null; quality: QualityPanel | null; commercial: CommercialPanel | null
}

export const stageLabels: Record<string, string> = {
  PREPARACAO: 'Preparação', BATER_MASSA: 'Bater massa', CILINDROS: 'Cilindros', EMBALAGEM: 'Embalagem', OUTRA: 'Outra',
}
export const statusLabels: Record<string, string> = {
  QUARENTENA: 'Quarentena', LIBERADO: 'Liberado', BLOQUEADO: 'Bloqueado', REPROVADO: 'Reprovado',
}
export const classificationLabels: Record<string, string> = {
  INSUMO: 'Insumos', FABRICACAO_PROPRIA: 'Fabricação própria', TERCEIRO: 'Terceiros',
  REVENDA_A_VALIDAR: 'Revenda (a validar)', FARINHA_USO_REVENDA_A_VALIDAR: 'Farinha uso/revenda (a validar)',
}
export const panelTitles: Record<PanelId, string> = {
  production: 'Produção', stock: 'Estoque', quality: 'Qualidade', commercial: 'Comercial',
}

export const kg = (value: Num) => value === null ? 'N/D' : `${formatStockQuantity(value)} kg`
export const pct = (value: Num) => value === null ? 'N/D' : `${formatStockQuantity(value)}%`
export const num = (value: Num, unit = '') => value === null ? 'N/D' : formatStockQuantity(value) + unit
export const brl = (value: Num) => value === null ? 'N/D' : formatBrl(Number(value).toFixed(2))

/** Monta as tabelas de cada painel. A mesma estrutura alimenta a tela, o PDF, o Excel e a impressão. */
export function panelSections(panel: PanelId, data: Panels): IndicatorSection[] {
  const metrics = ['Indicador', 'Valor']
  if (panel === 'production' && data.production) {
    const p = data.production
    return [
      { title: 'Planejado x realizado', columns: metrics, note: 'Ordens de produção com entrega no período. Realizado usa o peso medido ou, sem medição, o nominal.', rows: [
        ['Ordens com entrega no período', p.plan.orders], ['Planejado', kg(p.plan.planned_kg)], ['Realizado', kg(p.plan.produced_kg)],
        ['Atendimento do planejado', pct(p.plan.attainment_pct)], ['Massadas concluídas', `${p.plan.batches_done} de ${p.plan.batches_planned}`],
        ['Ordens concluídas', p.plan.complete], ['Ordens concluídas no prazo', p.plan.on_time], ['Ordens atrasadas', p.plan.late],
        ['Massadas finalizadas no período', p.finished_batches], ['Peso finalizado no período', kg(p.finished_kg)],
        ['Rendimento (medido sobre planejado)', pct(p.yield_pct)], ['Tempo médio do início à finalização', num(p.lead_hours, ' h')],
      ] },
      { title: 'Planejado x realizado por dia', columns: ['Data', 'Planejado (entrega)', 'Realizado (finalização)'],
        rows: p.daily.map(d => [dateLabel(d.day), kg(d.planned_kg), kg(d.produced_kg)]) },
      { title: 'Produtividade por etapa', columns: ['Etapa', 'Concluídas', 'Operadores', 'Tempo médio', 'Mediana', 'Pausa média', 'kg por hora'],
        note: 'Tempo líquido: do início à conclusão da etapa, descontadas as pausas.',
        rows: p.by_stage.map(s => [stageLabels[s.stage] ?? s.stage, s.completed, s.operators, num(s.avg_minutes, ' min'),
          num(s.median_minutes, ' min'), num(s.avg_pause_minutes, ' min'), num(s.kg_per_hour)]) },
      { title: 'Rendimento por receita', columns: ['Receita', 'Massadas', 'Planejado', 'Medido', 'Rendimento', 'Perdas', 'Tempo médio'],
        rows: p.by_recipe.map(r => [r.recipe_name, r.batches, kg(r.planned_kg), r.measured ? kg(r.actual_kg) : 'N/D',
          pct(r.yield_pct), kg(r.loss_kg), num(r.lead_hours, ' h')]) },
      { title: 'Ordens com entrega no período', columns: ['OP', 'Receita', 'Cliente', 'Entrega', 'Massadas', 'Planejado', 'Realizado', 'Situação'],
        rows: p.orders_due.map(o => [o.production_number, o.recipe_name, o.customer_name, dateLabel(o.delivery_date), `${o.done}/${o.batches_count}`,
          kg(o.planned_kg), kg(o.produced_kg), o.done >= o.batches_count ? 'Concluída' : o.late ? 'Atrasada' : 'Em andamento']) },
    ]
  }
  if (panel === 'stock' && data.stock) {
    const s = data.stock
    return [
      { title: 'Estoque atual', columns: metrics, note: 'Saldo atual, independente do período. kg soma apenas lotes em kg e g.', rows: [
        ['Lotes com saldo', s.lots], ['Peso em estoque', kg(s.kg)], ['Produto acabado liberado', kg(s.finished_goods_kg)],
        ['Em quarentena', s.quarantine], ['Bloqueados ou reprovados', s.blocked], ['Vencidos ou vencendo hoje', s.expired],
        ['Vencendo em 7 dias', s.expiring_7], ['Vencendo em 30 dias', s.expiring_30],
      ] },
      { title: 'Por situação', columns: ['Situação', 'Lotes', 'Peso'], rows: s.by_status.map(r => [statusLabels[r.status] ?? r.status, r.lots, kg(r.kg)]) },
      { title: 'Por classificação', columns: ['Classificação', 'Lotes', 'Peso'],
        rows: s.by_classification.map(r => [classificationLabels[r.classification] ?? r.classification, r.lots, kg(r.kg)]) },
    ]
  }
  if (panel === 'quality' && data.quality) {
    const q = data.quality
    const share = (title: string, first: string, rows: Share[], labels: Record<string, string> = {}) =>
      ({ title, columns: [first, 'Perdas'], rows: rows.map(r => [labels[r.name] ?? r.name, kg(r.kg)]) })
    return [
      { title: 'Qualidade no período', columns: metrics, rows: [
        ['Perdas registradas', kg(q.loss_kg)], ['Perdas sobre a produção', pct(q.loss_pct)],
        ['Massadas abaixo do peso nominal', `${q.underweight} de ${q.measured} medidas`],
        ['Recolhimentos abertos no período', q.recalls_opened], ['Recolhimentos em aberto', q.recalls_open],
        ['Lotes produzidos aguardando liberação', q.pending_release],
      ] },
      share('Perdas por motivo', 'Motivo', q.by_reason),
      share('Perdas por destino', 'Destino', q.by_destination),
      share('Perdas por operação', 'Operação', q.by_operation, stageLabels),
    ]
  }
  if (panel === 'commercial' && data.commercial) {
    const c = data.commercial
    return [
      { title: 'Pedidos com entrega no período', columns: metrics, rows: [
        ['Pedidos', c.orders], ['Peso pedido', kg(c.ordered_kg)], ['Expedidos', c.shipped], ['Parciais', c.partial],
        ['Em aberto', c.open], ['Atrasados', c.overdue], ['Expedições no período', c.shipments], ['Faturado no período', brl(c.billed_amount)],
      ] },
      { title: 'Clientes', columns: ['Cliente', 'Pedidos', 'Peso', 'Faturado'],
        rows: c.customers.map(r => [r.customer_name, r.orders, kg(r.kg), brl(r.amount)]) },
    ]
  }
  return []
}

export function filterPayload(filters: PanelFilters) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) as Partial<PanelFilters>
}
