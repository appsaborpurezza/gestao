import { formatStockQuantity } from '../../lib/decimal'

export function lossPareto(causes: { reason: string; kg: string }[]) {
  // The database sends exact decimals with up to six fractional digits.
  const entries = causes.map(cause => {
    const [whole, fraction = ''] = cause.kg.split('.')
    return { ...cause, microKg: BigInt(whole + fraction.padEnd(6, '0')) }
  }).sort((left, right) => left.microKg === right.microKg ? 0 : left.microKg > right.microKg ? -1 : 1)
  const total = entries.reduce((sum, entry) => sum + entry.microKg, 0n)
  if (total === 0n) return []

  const share = (quantity: bigint) => {
    const hundredths = (quantity * 10_000n + total / 2n) / total
    const decimal = hundredths.toString().padStart(3, '0')
    return {
      display: formatStockQuantity(decimal.slice(0, -2) + '.' + decimal.slice(-2)) + '%',
      value: Number(hundredths) / 100,
    }
  }
  let cumulative = 0n
  return entries.map(({ reason, kg, microKg }) => {
    cumulative += microKg
    return { reason, kg, share: share(microKg), cumulative: share(cumulative).display }
  })
}
