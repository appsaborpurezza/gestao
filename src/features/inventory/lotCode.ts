export function parseLotCode(value: string): string | null {
  const code = value.trim()
  if (!/^REC-[a-f0-9]{32}$/i.test(code)) return null
  return 'REC-' + code.slice(4).toLowerCase()
}
