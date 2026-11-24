type Cell = string | number
export type IndicatorSection = {
  title: string
  columns: string[]
  rows: Cell[][]
  note?: string
}

type ExportInput = {
  from: string
  to: string
  issuedAt: Date
  sections: IndicatorSection[]
}

const title = 'Sabor Purezza SMART | Indicadores'
export const dateLabel = (value: string) => value.split('-').reverse().join('/')
const localDateTime = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo',
})

function header(input: ExportInput) {
  return [
    title,
    `Período de ${dateLabel(input.from)} a ${dateLabel(input.to)}`,
    `Emitido em ${localDateTime.format(input.issuedAt)} (São Paulo)`,
  ]
}

export async function buildIndicatorsExcel(input: ExportInput) {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  for (const section of input.sections) {
    const sheet = workbook.addWorksheet(section.title, { views: [{ state: 'frozen', ySplit: 6 }] })
    section.columns.forEach((_, index) => { sheet.getColumn(index + 1).width = index === 0 ? 58 : 26 })
    for (const line of [...header(input), section.title, section.note ?? '']) {
      const row = sheet.addRow([line])
      sheet.mergeCells(row.number, 1, row.number, section.columns.length)
      row.getCell(1).alignment = { wrapText: true, vertical: 'middle' }
      row.height = row.number === 5 && section.note ? 46 : 20
    }
    const heading = sheet.addRow(section.columns)
    heading.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    heading.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF07558B' } }
    for (const values of section.rows) {
      const row = sheet.addRow(values)
      row.alignment = { wrapText: true, vertical: 'middle' }
    }
  }
  return workbook.xlsx.writeBuffer()
}

export async function buildIndicatorsPdf(input: ExportInput) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF({ format: 'a4', unit: 'mm', putOnlyUsedFonts: true })
  const margin = 14
  const width = doc.internal.pageSize.getWidth()
  const height = doc.internal.pageSize.getHeight()
  const headerLines = header(input)
  let startY = 39
  for (const section of input.sections) {
    autoTable(doc, {
      startY,
      margin: { top: 39, left: margin, right: margin, bottom: 15 },
      head: [[{ content: section.title, colSpan: section.columns.length }], section.columns],
      body: section.rows,
      foot: section.note ? [[{ content: section.note, colSpan: section.columns.length }]] : [],
      showFoot: 'lastPage',
      headStyles: { fillColor: [7, 85, 139] },
      footStyles: { fillColor: [240, 245, 250], textColor: [40, 48, 56], fontStyle: 'normal' },
      styles: { fontSize: 9, overflow: 'linebreak', valign: 'middle' },
      rowPageBreak: 'avoid',
      didDrawPage: ({ cursor }) => { if (cursor) startY = cursor.y + 7 },
    })
  }
  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page)
    doc.setTextColor(7, 85, 139)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(15)
    doc.text(headerLines[0]!, margin, 15)
    doc.setTextColor(40, 48, 56)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.text(headerLines.slice(1), margin, 22)
    doc.text(`Página ${page} de ${pages}`, width - margin, height - 7, { align: 'right' })
  }
  return doc
}
