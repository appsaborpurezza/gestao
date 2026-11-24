import QRCode from 'qrcode'
import decode from 'jsqr'
import { expect, test } from 'vitest'
import { parseLotCode } from '../src/features/inventory/lotCode'

const code = 'REC-1234567890abcdef1234567890abcdef'

test('normaliza o código de leitor USB e rejeita conteúdo de QR estranho', () => {
  expect(parseLotCode('  ' + code.toUpperCase() + '\r\n')).toBe(code)
  expect(parseLotCode('https://example.com/' + code)).toBeNull()
  expect(parseLotCode('REC-0000')).toBeNull()
  expect(parseLotCode(code + '0')).toBeNull()
})

test('o decodificador lê o mesmo formato de QR gerado para as etiquetas', () => {
  const matrix = QRCode.create(code, { errorCorrectionLevel: 'M' }).modules
  const margin = 4
  const scale = 5
  const size = (matrix.size + 2 * margin) * scale
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / scale) - margin
      const column = Math.floor(x / scale) - margin
      if (row < 0 || column < 0 || row >= matrix.size || column >= matrix.size || !matrix.get(row, column)) continue
      const offset = (y * size + x) * 4
      pixels.fill(0, offset, offset + 3)
    }
  }
  const result = decode(pixels, size, size, { inversionAttempts: 'dontInvert' })
  expect(parseLotCode(result?.data ?? '')).toBe(code)
})
