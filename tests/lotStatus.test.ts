import { describe, expect, it } from 'vitest'
import { expiryState, lotTotal } from '../src/features/inventory/lotStatus'

describe('expiryState', () => {
  it('classifica vencido, próximo e dentro do prazo', () => {
    expect(expiryState('2026-11-26', '2026-11-27')).toEqual({ state: 'expired', days: -1 })
    expect(expiryState('2026-11-27', '2026-11-27')).toEqual({ state: 'soon', days: 0 })
    expect(expiryState('2026-12-27', '2026-11-27')).toEqual({ state: 'soon', days: 30 })
    expect(expiryState('2026-12-28', '2026-11-27')).toEqual({ state: 'ok', days: 31 })
  })
  it('sem data informada', () => {
    expect(expiryState(null, '2026-11-27')).toEqual({ state: 'none', days: null })
  })
  it('atravessa o horário de verão sem erro de arredondamento', () => {
    expect(expiryState('2027-03-01', '2027-02-01').days).toBe(28)
  })
})

describe('lotTotal', () => {
  it('soma saldos numéricos e textuais', () => {
    expect(lotTotal([{ quantity: '1.5' }, { quantity: 2 }])).toBe(3.5)
    expect(lotTotal([])).toBe(0)
  })
})
