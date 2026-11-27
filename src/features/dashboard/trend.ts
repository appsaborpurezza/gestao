/** Período anterior com o mesmo número de dias, terminando na véspera do início. */
export function previousPeriod(period: { from: string; to: string }) {
  const day = 86_400_000
  const from = Date.parse(period.from + 'T00:00:00Z')
  const to = Date.parse(period.to + 'T00:00:00Z')
  const length = Math.round((to - from) / day) + 1
  const iso = (value: number) => new Date(value).toISOString().slice(0, 10)
  return { from: iso(from - length * day), to: iso(from - day) }
}

export type Trend = { direction: 'up' | 'down' | 'flat'; label: string } | null

/** Variação em relação ao período anterior. Sem base comparável, não há tendência. */
export function trend(current: number | string | null | undefined, previous: number | string | null | undefined, unit: 'percent' | 'points' = 'percent'): Trend {
  if (current === null || current === undefined || previous === null || previous === undefined) return null
  const now = Number(current)
  const before = Number(previous)
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null
  const format = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })
  if (unit === 'points') {
    const diff = now - before
    if (Math.abs(diff) < 0.05) return { direction: 'flat', label: 'Estável' }
    return { direction: diff > 0 ? 'up' : 'down', label: `${diff > 0 ? '+' : '−'}${format.format(Math.abs(diff))} p.p.` }
  }
  if (before === 0) return now === 0 ? { direction: 'flat', label: 'Estável' } : null
  const change = (now - before) / Math.abs(before) * 100
  if (Math.abs(change) < 0.5) return { direction: 'flat', label: 'Estável' }
  return { direction: change > 0 ? 'up' : 'down', label: `${change > 0 ? '+' : '−'}${format.format(Math.abs(change))}%` }
}
