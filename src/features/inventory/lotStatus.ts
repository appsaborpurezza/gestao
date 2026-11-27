export type LotStatus = 'QUARENTENA' | 'LIBERADO' | 'BLOQUEADO' | 'REPROVADO'
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export const lotStatusLabels: Record<LotStatus, string> = {
  QUARENTENA: 'Quarentena', LIBERADO: 'Liberado', BLOQUEADO: 'Bloqueado', REPROVADO: 'Reprovado',
}
export const lotStatusTones: Record<LotStatus, Tone> = {
  QUARENTENA: 'warning', LIBERADO: 'success', BLOQUEADO: 'danger', REPROVADO: 'neutral',
}
export const expiryLabels: Record<string, string> = {
  INFORMADA: 'Informada', DESCONHECIDA: 'Validade desconhecida', NAO_APLICAVEL: 'Não aplicável',
}

export type ExpiryState = { state: 'expired' | 'soon' | 'ok' | 'none'; days: number | null }

/** Classifica a validade em relação a hoje (AAAA-MM-DD em São Paulo). "soon" = até `window` dias. */
export function expiryState(expiresOn: string | null, today: string, window = 30): ExpiryState {
  if (!expiresOn) return { state: 'none', days: null }
  const days = Math.round((Date.parse(expiresOn + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000)
  return { state: days < 0 ? 'expired' : days <= window ? 'soon' : 'ok', days }
}

/** Saldo físico total do lote somando os locais. */
export function lotTotal(balances: { quantity: number | string }[]) {
  return balances.reduce((sum, balance) => sum + Number(balance.quantity), 0)
}
