import { dashboardPeriod } from '../features/dashboard/dashboardPeriods'

export const periodPresets = [
  ['today', 'Hoje'], ['yesterday', 'Ontem'], ['week', 'Esta semana'], ['previousWeek', 'Semana anterior'],
  ['month', 'Este mês'], ['previousMonth', 'Mês anterior'], ['last7', 'Últimos 7 dias'], ['last30', 'Últimos 30 dias'],
  ['year', 'Este ano'],
] as const
export type PeriodPreset = typeof periodPresets[number][0]
export type Period = { from: string; to: string }

/** Data de hoje no fuso de São Paulo (AAAA-MM-DD). */
export function todayInSaoPaulo(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now)
}

export function resolvePeriod(preset: PeriodPreset, today: string): Period {
  if (preset === 'last7' || preset === 'last30') {
    const start = new Date(today + 'T00:00:00Z')
    start.setUTCDate(start.getUTCDate() - (preset === 'last7' ? 6 : 29))
    return { from: start.toISOString().slice(0, 10), to: today }
  }
  return dashboardPeriod(preset, today)
}
