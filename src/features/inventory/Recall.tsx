import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { parseLotCode } from './lotCode'

type CaseDetails = {
  id: string; case_number: number; reason: string; opened_at: string; root_code: string
  closed_at: string | null; closed_by: string | null; close_reference: string | null
  lots: { code: string; status: string; prior_status: string; physical: string; unit: string }[]
  batches: { id: string; code: string; status: string; resume_authorized_at: string | null; resume_reference: string | null }[]
  shipments: { id: string; code: string; order_number: number; customer: string; quantity: string; unit: string; dispatched_at: string }[]
  actions: { id: string; note: string; shipment_id: string | null; recorded_at: string; operator: string }[]
}
const local = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short',
})
const stamp = (value: string) => local.format(new Date(value))
const success: Record<string, string> = {
  open_lot_recall: 'Recolhimento aberto.',
  record_recall_action: 'Ação registrada.',
  close_lot_recall: 'Recolhimento encerrado. As situações dos lotes foram preservadas.',
  authorize_recall_batch_resume: 'Avaliação de retomada registrada para este caso.',
}

export function Recall({ canOpen, canResolve }: { canOpen: boolean; canResolve: boolean }) {
  const cache = useQueryClient()
  const [selected, setSelected] = useState('')
  const [opening, setOpening] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null)
  const inFlight = useRef(false)
  const requests = useRef(new Map<string, string>())
  const cases = useQuery({
    queryKey: ['recall', 'cases'],
    queryFn: async () => {
      const { data, error } = await supabase.from('recall_cases').select('id,case_number,opened_at,closed_at')
        .order('case_number', { ascending: false })
      if (error) throw error
      return data
    },
  })
  const details = useQuery({
    queryKey: ['recall', 'details', selected],
    enabled: Boolean(selected),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('lot_recall_details', { target_case: selected })
      if (error) throw error
      return data as CaseDetails | null
    },
  })

  async function submit(event: FormEvent<HTMLFormElement>, operation: 'open_lot_recall' | 'record_recall_action'
    | 'close_lot_recall' | 'authorize_recall_batch_resume', targetBatch?: string) {
    event.preventDefault()
    if (inFlight.current) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const code = parseLotCode(String(fields.get('lot') ?? ''))
    if (operation === 'open_lot_recall' && !code) {
      setFeedback({ text: 'Informe um código interno de lote válido.', error: true })
      return
    }
    const params = operation === 'open_lot_recall' ? { target_code: code, reason: fields.get('reason') }
      : operation === 'record_recall_action' ? { target_case: selected, target_shipment: fields.get('shipment') || null, note: fields.get('action') }
      : operation === 'close_lot_recall' ? { target_case: selected, evaluation: fields.get('evaluation') }
      : { target_case: selected, target_batch: targetBatch, evaluation: fields.get('evaluation') }
    const fingerprint = JSON.stringify([operation, params])
    const request_id = requests.current.get(fingerprint) ?? crypto.randomUUID()
    requests.current.set(fingerprint, request_id)
    inFlight.current = true
    setBusy(true)
    setFeedback(null)
    try {
      const { data, error } = await supabase.rpc(operation, { ...params, request_id })
      if (error) throw new Error(error.message)
      requests.current.delete(fingerprint)
      form.reset()
      if (operation === 'open_lot_recall') {
        setSelected(data as string)
        setOpening(false)
      }
      if (operation !== 'record_recall_action') {
        await Promise.all([
          cache.invalidateQueries({ queryKey: ['inventory'] }),
          cache.invalidateQueries({ queryKey: ['shipping'] }),
          cache.invalidateQueries({ queryKey: ['orders'] }),
          cache.invalidateQueries({ queryKey: ['production-board'] }),
        ])
      }
      await cache.invalidateQueries({ queryKey: ['recall'] })
      setFeedback({ text: success[operation]!, error: false })
    } catch (cause) {
      setFeedback({ text: cause instanceof Error ? cause.message : 'Falha ao atualizar o recolhimento.', error: true })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <section className="panel">
    <h1>Recolhimentos</h1>
    {canOpen && (opening ? <form onSubmit={event => void submit(event, 'open_lot_recall')}>
      <p>A abertura bloqueia o lote de origem e os derivados identificados. Confira o código antes de confirmar.</p>
      <label>Código interno do lote de origem <input name="lot" required/></label>
      <label>Motivo do recolhimento <textarea name="reason" maxLength={1000} required rows={3}/></label>
      <div className="customer-actions">
        <button disabled={busy}>Confirmar abertura e bloqueio</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => { setOpening(false); setFeedback(null) }}>Voltar</button>
      </div>
    </form> : <button type="button" onClick={() => { setOpening(true); setFeedback(null) }}>Abrir recolhimento</button>)}
    {feedback && <p role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {cases.isPending && <p role="status">Carregando recolhimentos…</p>}
    {cases.isError && <p role="alert">Falha ao consultar recolhimentos.</p>}
    {cases.data?.length === 0 && <p>Nenhum recolhimento cadastrado.</p>}
    {!!cases.data?.length && <label>Recolhimento <select value={selected} disabled={busy}
      onChange={event => { setSelected(event.target.value); setFeedback(null) }}>
      <option value="">Selecione</option>
      {cases.data.map(incident => <option key={incident.id} value={incident.id}>
        Caso {incident.case_number} · {stamp(incident.opened_at)} · {incident.closed_at ? 'Encerrado' : 'Ativo'}
      </option>)}
    </select></label>}
    {selected && details.isPending && <p role="status">Carregando detalhes…</p>}
    {details.isError && <p role="alert">Falha ao consultar o caso.</p>}
    {details.data && <article>
      <h2>Caso {details.data.case_number}</h2>
      <p className="break-code">Origem {details.data.root_code} · {stamp(details.data.opened_at)}</p>
      <p>{details.data.reason}</p>
      {details.data.closed_at ? <p>Encerrado em {stamp(details.data.closed_at)} · {details.data.closed_by} · {details.data.close_reference}</p>
        : <p>Recolhimento ativo.</p>}
      {canResolve && !details.data.closed_at && <details>
        <summary>Encerrar recolhimento</summary>
        <p>O encerramento mantém os lotes bloqueados e as massadas em andamento sem autorização de retomada.</p>
        <form onSubmit={event => void submit(event, 'close_lot_recall')}>
          <label>Conclusão ou referência da avaliação sanitária <textarea name="evaluation" maxLength={1000} required rows={3}/></label>
          <button disabled={busy}>Confirmar encerramento</button>
        </form>
      </details>}
      <h3>Lotes afetados</h3>
      <ul>{details.data.lots.map(lot => <li className="break-code" key={lot.code}>
        {lot.code} · {lot.status} · Saldo físico {formatStockQuantity(lot.physical)} {lot.unit}
      </li>)}</ul>
      <h3>Massadas afetadas</h3>
      {details.data.batches.length ? <ul>{details.data.batches.map(batch =>
        <li key={batch.id}>{batch.code} · {batch.status}
          {batch.resume_authorized_at && <p>Retomada autorizada neste caso em {stamp(batch.resume_authorized_at)} · {batch.resume_reference}</p>}
          {!batch.resume_authorized_at && batch.status !== 'FINALIZADA' && <p>Retomada pendente de avaliação.</p>}
          {canResolve && details.data?.closed_at && !batch.resume_authorized_at && batch.status !== 'FINALIZADA' &&
            <details><summary>Avaliar retomada</summary>
              <form onSubmit={event => void submit(event, 'authorize_recall_batch_resume', batch.id)}>
                <label>Referência da avaliação sanitária <textarea name="evaluation" maxLength={1000} required rows={2}/></label>
                <button disabled={busy}>Autorizar retomada neste caso</button>
              </form>
            </details>}
        </li>)}</ul> : <p>Nenhuma massada vinculada.</p>}
      <h3>Destinos afetados</h3>
      {details.data.shipments.length ? <ul>{details.data.shipments.map(shipment => <li key={shipment.id} className="break-code">
        Pedido {shipment.order_number} · {shipment.customer} · {shipment.code} · {formatStockQuantity(shipment.quantity)} {shipment.unit}
        {' · '}{stamp(shipment.dispatched_at)}
      </li>)}</ul> : <p>Nenhum despacho vinculado.</p>}
      <h3>Ações e contatos</h3>
      <form onSubmit={event => void submit(event, 'record_recall_action')}>
        <label>Despacho vinculado <select name="shipment">
          <option value="">Ação geral</option>
          {details.data.shipments.map(shipment => <option key={shipment.id} value={shipment.id}>
            Pedido {shipment.order_number} · {shipment.customer} · {stamp(shipment.dispatched_at)}
          </option>)}
        </select></label>
        <label>Ação realizada <textarea name="action" maxLength={1000} rows={2} required/></label>
        <button disabled={busy}>Registrar ação</button>
      </form>
      {details.data.actions.length ? <ul>{details.data.actions.map(action => <li key={action.id}>
        {stamp(action.recorded_at)} · {action.operator} · {action.note}
      </li>)}</ul> : <p>Nenhuma ação registrada.</p>}
    </article>}
  </section>
}
