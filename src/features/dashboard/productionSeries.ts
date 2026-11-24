export type ProductionDay = {
  day: string
  finished_count: number
  measured_count: number
  measured_kg: string | null
  loss_kg: string | null
}

export type Grouping = 'day' | 'week' | 'month'

function addWeight(left: string | null, right: string | null) {
  if (left === null || right === null) return left ?? right
  const [leftWhole, leftFraction = ''] = left.split('.')
  const [rightWhole, rightFraction = ''] = right.split('.')
  const scale = Math.max(leftFraction.length, rightFraction.length)
  const sum = BigInt(leftWhole + leftFraction.padEnd(scale, '0')) + BigInt(rightWhole + rightFraction.padEnd(scale, '0'))
  if (scale === 0) return sum.toString()
  const digits = sum.toString().padStart(scale + 1, '0')
  return digits.slice(0, -scale) + '.' + digits.slice(-scale)
}

function bucket(day: string, grouping: 'week' | 'month') {
  if (grouping === 'month') return day.slice(0, 7) + '-01'
  // The server already converted timestamps to São Paulo dates. Use UTC only for calendar arithmetic.
  const monday = new Date(day + 'T00:00:00Z')
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7)
  return monday.toISOString().slice(0, 10)
}

export function groupProductionSeries(days: ProductionDay[], grouping: Grouping) {
  if (grouping === 'day') return days.map(total => ({ total, days: [total] }))
  const groups = new Map<string, { total: ProductionDay; days: ProductionDay[] }>()
  for (const day of days) {
    const start = bucket(day.day, grouping)
    const group = groups.get(start)
    if (!group) {
      groups.set(start, { total: { ...day, day: start }, days: [day] })
      continue
    }
    const { total } = group
    group.total = {
      day: start,
      finished_count: total.finished_count + day.finished_count,
      measured_count: total.measured_count + day.measured_count,
      measured_kg: addWeight(total.measured_kg, day.measured_kg),
      loss_kg: addWeight(total.loss_kg, day.loss_kg),
    }
    group.days.push(day)
  }
  return [...groups.values()].sort((left, right) => left.total.day.localeCompare(right.total.day))
}
