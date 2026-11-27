import { readFile, writeFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { buildCommercialPdf, type CommercialDocument } from '../src/features/orders/commercialPdf'

const fixture: CommercialDocument = {
  version: 1, renderer_version: 1, issued_at: '2026-11-24T15:30:00Z', snapshot_hash: '1234567890abcdef'.repeat(4),
  snapshot: {
    order_number: '123', order_issued_on: '2026-11-24',
    customer: { name: 'Comércio de Massas Fictício', street: 'Rua São João', address_number: '100',
      complement: null, district: 'Jardim', city: 'Americana', uf: 'SP', postal_code: '13470000',
      phone: '(19) 0000-0000', contact: 'João', document: null, state_registration: null },
    company: { name: 'Sabor Purezza Massas', address: 'Rua Sinceridade, 99 - Jardim da Paz, Americana/SP',
      phone: '(19) 3407-3111 / (19) 99784-4790' },
    payment_terms: 'Duas parcelas', payment_due_date: null, notes: 'Observação comercial fictícia.',
    total: '120.00',
    items: [{ description: 'Massa de pastel tradicional', quantity: '12.000000', unit: 'un', unit_price: '10.00',
      discount: '0.00', total: '120.00' }],
    installments: [{ due_on: '2026-12-10', amount: '60.00' }, { due_on: '2026-12-24', amount: '60.00' }],
  },
}
const logo = async () => 'data:image/png;base64,' + (await readFile(new URL('../public/logo-512.png', import.meta.url))).toString('base64')

test('documento comercial com um item cabe em A4 e a mesma versão gera os mesmos bytes', async () => {
  const asset = await logo()
  const pdf = await buildCommercialPdf(fixture, asset)
  expect(pdf.getNumberOfPages()).toBe(1)
  expect(pdf.internal.pageSize.getWidth()).toBeCloseTo(210)
  expect(pdf.internal.pageSize.getHeight()).toBeCloseTo(297)
  const bytes = Buffer.from(pdf.output('arraybuffer'))
  const repeat = await buildCommercialPdf(fixture, asset)
  expect(bytes.equals(Buffer.from(repeat.output('arraybuffer')))).toBe(true)
  const raw = bytes.toString('latin1')
  expect(raw).toContain('VIA CLIENTE')
  expect(raw).toContain('VIA EMPRESA')
  if (process.env.PUREZZA_COMMERCIAL_CHECK) await writeFile(process.env.PUREZZA_COMMERCIAL_CHECK + '-single.pdf', bytes)
}, 15_000)

test('pedido extenso gera duas vias de cada trecho com identificação de página', async () => {
  const item = fixture.snapshot.items[0]!
  const items = Array.from({ length: 70 }, (_, index) => ({ ...item,
    description: 'Produto ' + (index + 1) + ' com descrição longa para verificar as quebras de linha na impressão' }))
  const pdf = await buildCommercialPdf({ ...fixture, snapshot: { ...fixture.snapshot, items } }, await logo())
  const pages = pdf.getNumberOfPages()
  expect(pages).toBeGreaterThan(1)
  const bytes = Buffer.from(pdf.output('arraybuffer'))
  const raw = bytes.toString('latin1')
  expect(raw.match(/VIA CLIENTE/g)).toHaveLength(pages)
  expect(raw.match(/VIA EMPRESA/g)).toHaveLength(pages)
  expect(raw.match(/Produto 70 /g)).toHaveLength(2)
  if (process.env.PUREZZA_COMMERCIAL_CHECK) await writeFile(process.env.PUREZZA_COMMERCIAL_CHECK + '-many.pdf', bytes)
}, 15_000)
