import { formatStockQuantity } from '../../lib/decimal'

export type StockPositionRow = {
  item_code: string
  item_description: string
  lot_code: string
  location_code: string
  unit: string
  quantity: string
}

type ExportInput = {
  date: string
  generatedAt: string
  item: string
  location: string
  rows: StockPositionRow[]
}

const title = 'Sabor Purezza SMART | Posição de estoque'
const columns = ['Código', 'Descrição', 'Lote interno', 'Local', 'Unidade', 'Saldo físico']
const quantityFormat = '#,##0.######'
const issuedAt = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo',
})

function metadata(input: ExportInput) {
  return [
    'Posição em ' + input.date.split('-').reverse().join('/'),
    'Emitido em ' + issuedAt.format(new Date(input.generatedAt)) + ' (São Paulo)',
    'Item: ' + input.item + ' | Local: ' + input.location,
    (input.rows.length === 1 ? '1 posição' : input.rows.length + ' posições'),
  ]
}

function excelQuantity(value: string) {
  const digits = value.replace(/[^0-9]/g, '').replace(/^0+|0+$/g, '')
  return digits.length <= 15 ? Number(value) : value.replace('.', ',')
}

export async function buildStockPositionExcel(input: ExportInput) {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Posição de estoque', { views: [{ state: 'frozen', ySplit: 6 }] })
  const widths = [12, 58, 40, 24, 12, 25]
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width })
  for (const [index, line] of [title, ...metadata(input)].entries()) {
    const row = index + 1
    sheet.mergeCells(row, 1, row, columns.length)
    const cell = sheet.getCell(row, 1)
    cell.value = line
    cell.alignment = { vertical: 'middle', wrapText: true }
    sheet.getRow(row).height = row === 4 ? 32 : 20
    if (row === 1) cell.font = { bold: true, size: 14, color: { argb: 'FF07558B' } }
  }
  const header = sheet.addRow(columns)
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF07558B' } }
  sheet.autoFilter = { from: 'A6', to: 'F' + (6 + input.rows.length) }
  for (const row of input.rows) {
    const entry = sheet.addRow([row.item_code, row.item_description, row.lot_code,
      row.location_code, row.unit, excelQuantity(row.quantity)])
    entry.getCell(2).alignment = { wrapText: true, vertical: 'top' }
    entry.getCell(6).numFmt = quantityFormat
  }
  return workbook.xlsx.writeBuffer()
}

export async function buildStockPositionPdf(input: ExportInput) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF({ orientation: 'landscape', format: 'a4', unit: 'mm', putOnlyUsedFonts: true })
  const left = 12
  const right = doc.internal.pageSize.getWidth() - left
  doc.setFontSize(9)
  const lines: string[] = metadata(input).flatMap(line => doc.splitTextToSize(line, right - left))
  const top = 27 + lines.length * 4.2
  autoTable(doc, {
    margin: { top, left, right: left, bottom: 16 },
    head: [columns],
    body: input.rows.map(row => [row.item_code, row.item_description, row.lot_code,
      row.location_code, row.unit, formatStockQuantity(row.quantity)]),
    styles: { fontSize: 8.5, overflow: 'linebreak', valign: 'top' },
    rowPageBreak: 'avoid',
    headStyles: { fillColor: [7, 85, 139] },
    columnStyles: { 0: { cellWidth: 20 }, 2: { cellWidth: 74 }, 3: { cellWidth: 33 },
      4: { cellWidth: 20 }, 5: { cellWidth: 43, halign: 'right' } },
    willDrawPage: () => {
      doc.setTextColor(7, 85, 139)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(15)
      doc.text(title, left, 14)
      doc.setTextColor(40, 48, 56)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      lines.forEach((line, index) => doc.text(line, left, 21 + index * 4.2))
    },
  })
  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page)
    doc.setFontSize(8)
    doc.setTextColor(40, 48, 56)
    doc.text('Página ' + page + ' de ' + pages, right, doc.internal.pageSize.getHeight() - 7, { align: 'right' })
  }
  return doc
}
