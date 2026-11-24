import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { CommercialDocument as DocumentData } from './commercialPdf'

async function loadLogo() {
  const response = await fetch(import.meta.env.BASE_URL + 'logo.png')
  if (!response.ok) throw new Error('Falha ao carregar o logotipo.')
  const blob = await response.blob()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Falha ao ler o logotipo.'))
    reader.readAsDataURL(blob)
  })
}

export function CommercialDocumentButton({ orderId }: { orderId: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pages, setPages] = useState(0)
  const inFlight = useRef(false)

  async function download() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    setPages(0)
    try {
      const [{ buildCommercialPdf }, logo] = await Promise.all([import('./commercialPdf'), loadLogo()])
      const { data, error } = await supabase.rpc('issue_commercial_document', { target_order: orderId })
      if (error) throw new Error(error.message)
      const document = data as DocumentData
      const pdf = await buildCommercialPdf(document, logo)
      pdf.save('pedido-' + document.snapshot.order_number + '-v' + document.version + '.pdf')
      setPages(pdf.getNumberOfPages())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao preparar o documento comercial.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <div>
    <button type="button" disabled={busy} onClick={() => void download()}>
      {busy ? 'Gerando PDF…' : 'Baixar PDF comercial (duas vias)'}
    </button>
    {error && <p role="alert">{error}</p>}
    {pages > 1 && <p role="status">O pedido ocupa {pages} folhas. Cada folha contém o mesmo trecho nas duas vias numeradas.</p>}
  </div>
}

export function CommercialDocumentSettings({ onClose }: { onClose: () => void }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<{ fingerprint: string; id: string } | null>(null)
  const inFlight = useRef(false)
  const settings = useQuery({
    queryKey: ['orders', 'commercial-document-settings'],
    queryFn: async () => {
      const { data, error } = await supabase.from('commercial_document_settings')
        .select('company_name,company_address,company_phone,version').single()
      if (error) throw error
      return data
    },
  })

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!settings.data || inFlight.current) return
    const input = Object.fromEntries(new FormData(event.currentTarget))
    const fingerprint = JSON.stringify(input)
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.rpc('configure_commercial_document', {
        expected_version: settings.data.version, input, request_id: request.current.id,
      })
      if (error) throw new Error(error.message)
      await cache.invalidateQueries({ queryKey: ['orders', 'commercial-document-settings'] })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao salvar os dados da empresa.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <section>
    <h2>Dados da empresa no PDF comercial</h2>
    {settings.isPending && <p role="status">Carregando configuração…</p>}
    {settings.isError && <p role="alert">Falha ao consultar a configuração.</p>}
    {settings.data && <form onSubmit={save}>
      <label>Nome <input name="company_name" defaultValue={settings.data.company_name} maxLength={180} required/></label>
      <label>Endereço <input name="company_address" defaultValue={settings.data.company_address} maxLength={300} required/></label>
      <label>Telefone <input name="company_phone" defaultValue={settings.data.company_phone} maxLength={100} required/></label>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy}>{busy ? 'Salvando…' : 'Salvar para novas emissões'}</button>
    </form>}
    <button type="button" disabled={busy} className="secondary" onClick={onClose}>Voltar</button>
  </section>
}
