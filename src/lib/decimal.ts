export function formatStockQuantity(value: string) {
  const [whole, decimal = ''] = value.split('.')
  const fraction = decimal.replace(/0+$/, '')
  return whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (fraction ? ',' + fraction : '')
}

export function formatBrl(value: string) {
  const [whole, fraction = ''] = value.split('.')
  return 'R$ ' + formatStockQuantity(whole!) + ',' + fraction.padEnd(2, '0')
}

export function subtractAmount(total: string, paid: string) {
  const cents = (value: string) => {
    const [whole, fraction = ''] = value.split('.')
    return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))
  }
  const balance = (cents(total) - cents(paid)).toString().padStart(3, '0')
  return balance.slice(0, -2) + '.' + balance.slice(-2)
}
