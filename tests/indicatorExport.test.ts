import ExcelJS from 'exceljs'
import { expect, test } from 'vitest'
import { buildIndicatorsExcel, buildIndicatorsPdf } from '../src/features/dashboard/indicatorExport'

const input = {
  from: '2026-11-01',
  to: '2026-11-24',
  issuedAt: new Date('2026-11-25T01:30:00Z'),
  sections: [{
    title: 'Produção e perdas por dia',
    columns: ['Data', 'Finalizadas', 'Peso medido'],
    rows: Array.from({ length: 100 }, (_, index) => ['24/11/2026', index, index === 99 ? 'N/D' : '100,5 kg']),
  }],
}

test('Excel conserva o período, a data local e todas as linhas da consulta', async () => {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await buildIndicatorsExcel(input))
  expect(workbook.worksheets).toHaveLength(1)
  const sheet = workbook.worksheets[0]!
  expect(sheet.getCell('A2').value).toBe('Período de 01/11/2026 a 24/11/2026')
  expect(sheet.getCell('A3').value).toContain('24/11/2026')
  expect(sheet.getCell('B106').value).toBe(99)
  expect(sheet.getCell('C106').value).toBe('N/D')
})

test('PDF pagina a série completa e imprime o cabeçalho e numeração', async () => {
  const doc = await buildIndicatorsPdf(input)
  const pages = doc.getNumberOfPages()
  expect(pages).toBeGreaterThan(1)
  const output = doc.output()
  expect(output).toContain('Sabor Purezza SMART | Indicadores')
  expect(output).toContain(`Página ${pages} de ${pages}`)
  expect(output).toContain('(N/D)')
})
