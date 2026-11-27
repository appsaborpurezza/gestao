export const dashboardPresets = [
  ['today', 'Hoje'], ['yesterday', 'Ontem'], ['week', 'Esta semana'], ['previousWeek', 'Semana anterior'],
  ['month', 'Este mês'], ['previousMonth', 'Mês anterior'], ['year', 'Este ano'],
] as const

export function dashboardPeriod(preset: typeof dashboardPresets[number][0], today: string) {
  const date = new Date(today + 'T00:00:00Z')
  const day = (shift: number) => {
    const shifted = new Date(date)
    shifted.setUTCDate(shifted.getUTCDate() + shift)
    return shifted.toISOString().slice(0, 10)
  }
  const sinceMonday = (date.getUTCDay() + 6) % 7
  switch (preset) {
    case 'today': return { from: today, to: today }
    case 'yesterday': return { from: day(-1), to: day(-1) }
    case 'week': return { from: day(-sinceMonday), to: today }
    case 'previousWeek': return { from: day(-sinceMonday - 7), to: day(-sinceMonday - 1) }
    case 'month': return { from: today.slice(0, 7) + '-01', to: today }
    case 'previousMonth': {
      const lastDay = day(-date.getUTCDate())
      return { from: lastDay.slice(0, 7) + '-01', to: lastDay }
    }
    case 'year': return { from: today.slice(0, 4) + '-01-01', to: today }
  }
}
