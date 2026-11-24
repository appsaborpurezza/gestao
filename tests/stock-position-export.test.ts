import { writeFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import { expect, test } from 'vitest'
import { buildStockPositionExcel, buildStockPositionPdf } from '../src/features/inventory/stockPositionExport'

const input = {
  date: '2024-05-02',
  generatedAt: '2024-05-03T03:00:00Z',
  item: 'Farinha para produção',
  location: 'Todos',
  rows: Array.from({ length: 95 }, (_, index) => ({
    item_code: String(index + 1),
    item_description: 'Farinha de trigo · lote de produção número ' + (index + 1),
    lot_code: 'REC-' + index.toString(16).padStart(32, '0'),
    location_code: 'GALPÃO-01',
    unit: 'kg',
    quantity: index === 0 ? '999999999999.000001' : '6.250000',
  })),
}

test('o Excel inclui todas as linhas e preserva saldos com mais de 15 dígitos', async () => {
  const content = await buildStockPositionExcel(input)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(content)
  const sheet = workbook.getWorksheet('Posição de estoque')!
  expect(sheet.rowCount).toBe(101)
  expect(sheet.getCell('A2').value).toBe('Posição em 02/05/2024')
  expect(sheet.getCell('A4').value).toContain('Farinha para produção')
  expect(sheet.getCell('F7').value).toBe('999999999999,000001')
  expect(sheet.getCell('F8').value).toBe(6.25)
  expect(sheet.getCell('A101').value).toBe('95')
})

test('o PDF gera múltiplas páginas para o conjunto completo', async () => {
  const pdf = await buildStockPositionPdf(input)
  expect(pdf.getNumberOfPages()).toBeGreaterThan(1)
  const bytes = Buffer.from(pdf.output('arraybuffer'))
  expect(bytes.toString('latin1', 0, 5)).toBe('%PDF-')
  if (process.env.PUREZZA_PDF_CHECK) await writeFile(process.env.PUREZZA_PDF_CHECK, bytes)
})
