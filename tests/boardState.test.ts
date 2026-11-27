import { describe, expect, it } from 'vitest'
import { batchDeadline } from '../src/features/production/boardState'

describe('batchDeadline', () => {
  it('marca atraso, entrega próxima e em dia', () => {
    expect(batchDeadline({ delivery_date: '2026-11-26', status: 'EM_CILINDROS' }, '2026-11-27')).toBe('late')
    expect(batchDeadline({ delivery_date: '2026-11-29', status: 'PLANEJADA' }, '2026-11-27')).toBe('soon')
    expect(batchDeadline({ delivery_date: '2026-11-30', status: 'PLANEJADA' }, '2026-11-27')).toBe('ok')
  })
  it('ignora massada finalizada', () => {
    expect(batchDeadline({ delivery_date: '2026-11-01', status: 'FINALIZADA' }, '2026-11-27')).toBeNull()
  })
})
