import type { Grouping } from './productionSeries'

type Preferences = { from: string; to: string; grouping: Grouping }

export function defaultDashboardPreferences(today: string): Preferences {
  return { from: today.slice(0, 7) + '-01', to: today, grouping: 'day' }
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function dashboardPreferences(storage: Pick<Storage, 'getItem'>, key: string, today: string): Preferences {
  try {
    const stored = storage.getItem(key)
    if (stored) {
      const value = JSON.parse(stored) as Partial<Preferences> | null
      if (value && isCalendarDate(value.from) && isCalendarDate(value.to) && value.from <= value.to && value.to <= today
        && (value.grouping === 'day' || value.grouping === 'week' || value.grouping === 'month')) {
        return { from: value.from, to: value.to, grouping: value.grouping }
      }
    }
  } catch {
    // Private browser settings can deny storage access.
  }
  return defaultDashboardPreferences(today)
}
