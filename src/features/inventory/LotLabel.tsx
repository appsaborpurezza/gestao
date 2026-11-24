import { useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import QRCode from 'qrcode'
import { supabase } from '../../lib/supabase'

type Label = {
  internal_code: string
  original_lot: string
  description: string
  manufacturer: string
  manufactured_on: string | null
  expires_on: string | null
  expiry: 'INFORMADA' | 'DESCONHECIDA' | 'NAO_APLICAVEL'
  initial_quantity: string
  unit: string
  initial_location: string
  document: string | null
  document_type: string
}

const date = (value: string | null) => value?.split('-').reverse().join('/') ?? 'Não informada'
const quantity = (value: string) => value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace('.', ',')

export function LotLabel({ lotId }: { lotId: string }) {
  const [label, setLabel] = useState<{ data: Label; qr: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<string | null>(null)
  const inFlight = useRef(false)

  useEffect(() => {
    const clear = () => setLabel(null)
    window.addEventListener('afterprint', clear)
    return () => window.removeEventListener('afterprint', clear)
  }, [])

  async function print() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    const requestId = request.current ?? crypto.randomUUID()
    request.current = requestId
    try {
      const { data, error } = await supabase.rpc('request_inventory_label', {
        target_lot: lotId, request_id: requestId,
      })
      if (error) throw new Error(error.message)

      const details = data as Label
      const qr = await QRCode.toDataURL(details.internal_code, { errorCorrectionLevel: 'M', width: 256 })
      const image = new Image()
      image.src = qr
      await image.decode()
      flushSync(() => setLabel({ data: details, qr }))
      window.print()
      request.current = null
    } catch (cause) {
      setLabel(null)
      setError(cause instanceof Error ? cause.message : 'Falha ao preparar a impressão.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <>
    <button type="button" onClick={() => void print()} disabled={busy}>
      {busy ? 'Preparando etiqueta…' : 'Imprimir etiqueta interna'}
    </button>
    {error && <p role="alert">{error}</p>}
    {label && createPortal(<section className="lot-print">
      <div className="lot-label">
        <div>
          <p>Sabor Purezza Massas · Etiqueta interna</p>
          <h1>{label.data.description}</h1>
          <dl>
            <dt>Fabricante</dt><dd>{label.data.manufacturer}</dd>
            <dt>Lote interno</dt><dd>{label.data.internal_code}</dd>
            <dt>Lote original</dt><dd>{label.data.original_lot}</dd>
            <dt>Fabricação</dt><dd>{date(label.data.manufactured_on)}</dd>
            <dt>Validade</dt><dd>{label.data.expiry === 'NAO_APLICAVEL' ? 'Não aplicável' : date(label.data.expires_on)}</dd>
            <dt>Quantidade inicial</dt><dd>{quantity(label.data.initial_quantity)} {label.data.unit}</dd>
            <dt>Local inicial</dt><dd>{label.data.initial_location}</dd>
            <dt>{label.data.document_type}</dt><dd>{label.data.document ?? 'Não informado'}</dd>
          </dl>
        </div>
        <img src={label.qr} width="110" height="110" alt="QR do código interno do lote"/>
      </div>
    </section>, document.body)}
  </>
}
