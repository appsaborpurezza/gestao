import { useEffect, useRef, useState, type FormEvent } from 'react'
import { parseLotCode } from './lotCode'

export function LotScanner({ onFind }: { onFind: (code: string) => void }) {
  const [active, setActive] = useState(false)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const find = useRef(onFind)
  useEffect(() => { find.current = onFind }, [onFind])

  useEffect(() => {
    if (!active) return
    let stopped = false
    let stream: MediaStream | undefined
    let frame = 0
    const element = video.current

    async function start() {
      if (!element || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('A câmera exige um navegador compatível e uma conexão HTTPS.')
      }
      const { default: decode } = await import('jsqr')
      if (stopped) return
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: 'environment' } },
      })
      if (stopped) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      const [track] = stream.getVideoTracks()
      track?.addEventListener('ended', () => {
        if (stopped) return
        setError('A câmera foi desconectada. Use o código do lote para continuar.')
        setActive(false)
      }, { once: true })
      element.srcObject = stream
      await element.play()
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('O navegador não conseguiu preparar a leitura da câmera.')

      let lastScan = 0
      function scan(time: number) {
        if (stopped || !element) return
        if (time - lastScan >= 120 && element.readyState >= 2 && element.videoWidth && element.videoHeight) {
          lastScan = time
          const scale = Math.min(1, 640 / Math.max(element.videoWidth, element.videoHeight))
          canvas.width = Math.round(element.videoWidth * scale)
          canvas.height = Math.round(element.videoHeight * scale)
          context!.drawImage(element, 0, 0, canvas.width, canvas.height)
          const { data } = context!.getImageData(0, 0, canvas.width, canvas.height)
          const result = decode(data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })
          if (result) {
            const code = parseLotCode(result.data)
            if (code) {
              setText(code)
              setError('')
              setActive(false)
              find.current(code)
              return
            }
            setError('O QR lido não é um código interno de lote.')
          }
        }
        frame = requestAnimationFrame(scan)
      }
      if (!stopped) frame = requestAnimationFrame(scan)
    }

    void start().catch(cause => {
      if (stopped) return
      setError(cause instanceof DOMException
        ? 'Câmera indisponível ou sem permissão. Digite ou leia o código com um leitor USB.'
        : cause instanceof Error ? cause.message : 'Falha na leitura da câmera.')
      setActive(false)
    })
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach(track => track.stop())
      if (element) element.srcObject = null
    }
  }, [active])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = parseLotCode(text)
    if (!code) {
      setError('Informe um código interno de lote válido.')
      return
    }
    setError('')
    setActive(false)
    onFind(code)
  }

  return <section aria-label="Localizar lote" className="lot-finder">
    <form onSubmit={submit}>
      <label>Localizar lote pelo código interno <input value={text} onChange={event => setText(event.target.value)}
        autoComplete="off" spellCheck={false} required placeholder="Digite ou use o leitor"/></label>
      <button className="secondary">Consultar lote</button>
      <button type="button" className="secondary" onClick={() => {
        setError('')
        setActive(current => !current)
      }}>{active ? 'Desligar câmera' : 'Ler QR com a câmera'}</button>
    </form>
    {active && <video ref={video} className="lot-camera" muted playsInline aria-label="Prévia da câmera para leitura do QR"/>}
    {error && <p className="ui-message" data-tone="danger" role="alert">{error}</p>}
  </section>
}
