type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export const stateTones: Record<'blocked' | 'paused' | 'done' | 'running' | 'waiting', Tone> = {
  blocked: 'danger', paused: 'neutral', done: 'success', running: 'warning', waiting: 'info',
}

/** Prazo da massada em relação à entrega do pedido: atrasada, próxima (até 2 dias) ou em dia. */
export function batchDeadline(batch: { delivery_date: string; status: string }, today: string) {
  if (batch.status === 'FINALIZADA') return null
  if (batch.delivery_date < today) return 'late'
  const limit = new Date(today + 'T00:00:00Z')
  limit.setUTCDate(limit.getUTCDate() + 2)
  return batch.delivery_date <= limit.toISOString().slice(0, 10) ? 'soon' : 'ok'
}
