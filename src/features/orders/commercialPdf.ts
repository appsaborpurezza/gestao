import { formatBrl, formatStockQuantity } from '../../lib/decimal'

type Customer = {
  name: string; street: string | null; address_number: string | null; complement: string | null
  district: string | null; city: string | null; uf: string | null; postal_code: string | null
  phone: string | null; contact: string | null; document: string | null; state_registration: string | null
}
export type CommercialDocument = {
  issued_at: string
  version: number
  renderer_version: number
  snapshot_hash: string
  snapshot: {
    order_number: string; order_issued_on: string; customer: Customer
    company: { name: string; address: string; phone: string }
    payment_terms: string | null; payment_due_date: string | null; notes: string | null; total: string
    items: { description: string; quantity: string; unit: string; unit_price: string; discount: string; total: string }[]
    installments: { due_on: string; amount: string }[]
  }
}
const date = (value: string) => value.split('-').reverse().join('/')
const disclaimer = 'Documento comercial — não substitui NF-e'
const lineHeight = 3.8

type Block = { height: number; draw: (y: number) => void }

export async function buildCommercialPdf(document: CommercialDocument, logoDataUrl: string) {
  if (document.renderer_version !== 1) throw new Error('Versão de documento comercial indisponível.')
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', putOnlyUsedFonts: true })
  const { snapshot } = document
  const buyer = snapshot.customer
  const company = snapshot.company
  const left = 11
  const right = 199
  const copyHeight = 148.5
  const issued = new Date(document.issued_at).toISOString().slice(0, 19).replace(/\D/g, '')
  pdf.setCreationDate("D:" + issued + "+00'00'")
  pdf.setFileId(document.snapshot_hash.slice(0, 32).toUpperCase())
  pdf.setProperties({ title: 'Pedido ' + snapshot.order_number, creator: 'Sabor Purezza SMART' })

  const wrap = (text: string, width: number, size = 9, bold = false): string[] => {
    pdf.setFont('helvetica', bold ? 'bold' : 'normal')
    pdf.setFontSize(size)
    return pdf.splitTextToSize(text, width)
  }
  const ink = (size: number, bold = false) => {
    pdf.setTextColor(22, 37, 52)
    pdf.setFont('helvetica', bold ? 'bold' : 'normal')
    pdf.setFontSize(size)
  }
  const drawLines = (lines: string[], x: number, y: number) => {
    lines.forEach((line, index) => pdf.text(line, x, y + index * lineHeight))
  }

  const companyName = wrap(company.name, 117, 11, true)
  const companyContact = wrap(company.address + ' · ' + company.phone, 117, 8)
  const headerStart = Math.max(37, 20 + (companyName.length + companyContact.length) * lineHeight)
  const contentEnd = 133
  const blocks: Block[] = []

  function textBlock(text: string, bold = false) {
    if (!text) return
    const lines = wrap(text, right - left - 4, 9, bold)
    for (const line of lines) {
      blocks.push({ height: lineHeight + 0.2, draw(y) { ink(9, bold); pdf.text(line, left + 2, y + 3) } })
    }
  }

  textBlock('Cliente: ' + buyer.name, true)
  const address = [buyer.street, buyer.address_number, buyer.complement, buyer.district,
    [buyer.city, buyer.uf].filter(Boolean).join('/'), buyer.postal_code && 'CEP ' + buyer.postal_code].filter(Boolean).join(' · ')
  textBlock(address && 'Endereço: ' + address)
  textBlock([buyer.phone && 'Telefone: ' + buyer.phone, buyer.contact && 'Contato: ' + buyer.contact,
    buyer.document && 'CPF/CNPJ: ' + buyer.document, buyer.state_registration && 'IE: ' + buyer.state_registration].filter(Boolean).join(' · '))
  textBlock(snapshot.payment_terms ? 'Condição de pagamento: ' + snapshot.payment_terms : '')
  const due = snapshot.payment_due_date ? date(snapshot.payment_due_date)
    : snapshot.installments.length === 1 ? date(snapshot.installments[0]!.due_on)
      : snapshot.installments.length > 1 ? 'Conforme parcelas' : 'Não informado'
  textBlock('Vencimento financeiro: ' + due, true)

  const columnEnd = [30, 40, 125, 148, 173, 198]
  const itemHeader: Block = {
    height: 6,
    draw(y) {
      pdf.setFillColor(7, 85, 139)
      pdf.rect(left, y, right - left, 5.5, 'F')
      pdf.setTextColor(255)
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(8)
      const names = ['Qtd.', 'Un.', 'Descrição', 'Preço unit.', 'Desconto', 'Total']
      names.forEach((label, index) => {
        pdf.text(label, index === 2 ? 43 : columnEnd[index]! - 1, y + 3.8, { align: index === 2 ? 'left' : 'right' })
      })
    },
  }
  const pages: Block[][] = [[]]
  let used = 0
  const capacity = contentEnd - headerStart
  function push(block: Block, repeatedHeader?: Block) {
    if (used + block.height > capacity) {
      pages.push(repeatedHeader ? [repeatedHeader] : [])
      used = repeatedHeader?.height ?? 0
    }
    pages[pages.length - 1]!.push(block)
    used += block.height
  }
  blocks.splice(0).forEach(block => push(block))
  if (capacity - used < itemHeader.height + 9) {
    pages.push([])
    used = 0
  }
  push(itemHeader)
  const maxLines = Math.max(1, Math.floor((capacity - itemHeader.height - 2) / lineHeight))
  for (const item of snapshot.items) {
    const lines = wrap(item.description, 80, 8.5)
    const cells = [formatStockQuantity(item.quantity), item.unit, '', formatBrl(item.unit_price),
      formatBrl(item.discount), formatBrl(item.total)]
    const widths = [17, 9, 80, 21, 23, 23]
    const wrappedCells = cells.map((cell, index) => cell ? wrap(cell, widths[index]!, 8.5) : [])
    for (let offset = 0; offset < lines.length; offset += maxLines) {
      const chunk = lines.slice(offset, offset + maxLines)
      const height = Math.max(6, Math.max(chunk.length, ...(offset === 0 ? wrappedCells.map(cell => cell.length) : [0])) * lineHeight + 2)
      push({ height, draw(y) {
        ink(8.5)
        drawLines(chunk, 43, y + 3.8)
        if (offset === 0) {
          wrappedCells.forEach((cell, index) => cell.forEach((line, row) => {
            pdf.text(line, columnEnd[index]! - 1, y + 3.8 + row * lineHeight, { align: 'right' })
          }))
        }
        pdf.setDrawColor(222, 229, 235)
        pdf.line(left, y + height, right, y + height)
      } }, itemHeader)
    }
  }

  textBlock('Total do pedido: ' + formatBrl(snapshot.total), true)
  if (snapshot.installments.length) {
    textBlock('Parcelas', true)
    snapshot.installments.forEach((entry, index) => textBlock(
      (index + 1) + ' · Vencimento ' + date(entry.due_on) + ' · ' + formatBrl(entry.amount)
    ))
  }
  if (snapshot.notes) textBlock('Observações: ' + snapshot.notes)
  blocks.forEach(block => push(block))

  function drawCopy(offset: number, label: string, content: Block[], index: number) {
    pdf.addImage(logoDataUrl, 'PNG', left, offset + 9, 19.5, 19.5, 'sabor-purezza-logo', 'FAST')
    ink(11, true)
    drawLines(companyName, 34, offset + 12)
    ink(8)
    drawLines(companyContact, 34, offset + 12 + companyName.length * lineHeight)
    ink(9, true)
    pdf.text(label, right, offset + 12, { align: 'right' })
    ink(8)
    pdf.text('Pedido ' + snapshot.order_number, right, offset + 17, { align: 'right' })
    pdf.text('Emissão ' + date(snapshot.order_issued_on), right, offset + 21, { align: 'right' })
    pdf.text('Via ' + (index + 1) + ' de ' + pages.length, right, offset + 25, { align: 'right' })
    let y = offset + headerStart
    for (const block of content) {
      block.draw(y)
      y += block.height
    }
    ink(8)
    pdf.text(disclaimer, left, offset + 140)
  }

  pages.forEach((content, index) => {
    if (index > 0) pdf.addPage()
    pdf.setDrawColor(125)
    pdf.setLineDashPattern([2, 2], 0)
    pdf.line(left, copyHeight, right, copyHeight)
    pdf.setLineDashPattern([], 0)
    drawCopy(0, 'VIA CLIENTE', content, index)
    drawCopy(copyHeight, 'VIA EMPRESA', content, index)
  })
  return pdf
}
