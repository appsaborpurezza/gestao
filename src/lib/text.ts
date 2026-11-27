/** Normaliza texto para comparação sem acentos e sem diferença de caixa. */
export function normalizeText(value: string) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
}

/** Verdadeiro quando todas as palavras do termo aparecem em algum dos campos. */
export function matchesTerm(term: string, ...fields: (string | number | null | undefined)[]) {
  const words = normalizeText(term).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = normalizeText(fields.filter(value => value != null).join(' '))
  return words.every(word => haystack.includes(word))
}

/** Divide o texto em trechos marcados para destacar a ocorrência do termo. */
export function highlightParts(text: string, term: string): { text: string; match: boolean }[] {
  const needle = normalizeText(term)
  if (!needle) return [{ text, match: false }]
  const folded = text.normalize('NFD').replace(/\p{Diacritic}/gu, '')
  // A normalização preserva o comprimento só para letras latinas compostas; quando não preservar, não destaca.
  if (folded.length !== text.length) return [{ text, match: false }]
  const lower = folded.toLowerCase()
  const parts: { text: string; match: boolean }[] = []
  let cursor = 0
  for (let index = lower.indexOf(needle); index >= 0; index = lower.indexOf(needle, cursor)) {
    if (index > cursor) parts.push({ text: text.slice(cursor, index), match: false })
    parts.push({ text: text.slice(index, index + needle.length), match: true })
    cursor = index + needle.length
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false })
  return parts
}

export const numberFormat = (digits = 0) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
export const formatDate = (iso: string | null | undefined) => iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(iso.slice(0, 10) + 'T00:00:00Z')) : '—'
