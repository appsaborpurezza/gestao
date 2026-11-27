import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert, X } from 'lucide-react'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { Badge, ErrorState, PageHeader, Skeleton } from '../../ui'
import { DataTable, type Column } from '../../ui/DataTable'
import { Tabs } from '../../ui/Tabs'
import { lotStatusLabels, lotStatusTones, type LotStatus } from './lotStatus'
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

type CaseRow = { id: string; case_number: number; opened_at: string; closed_at: string | null }
type Section = 'lots' | 'batches' | 'shipments' | 'actions'
const caseColumns: Column<CaseRow>[] = [
  { id: 'case', header: 'Caso', cell: row => <strong>Caso {row.case_number}</strong>, sortValue: row => row.case_number },
  { id: 'opened', header: 'Aberto em', cell: row => stamp(row.opened_at), sortValue: row => row.opened_at },
  { id: 'status', header: 'Situação', cell: row => row.closed_at
    ? <Badge>Encerrado em {stamp(row.closed_at)}</Badge> : <Badge tone="danger">Ativo</Badge> },
]
const LotBadge = ({ value }: { value: string }) =>
  <Badge tone={lotStatusTones[value as LotStatus] ?? 'neutral'}>{lotStatusLabels[value as LotStatus] ?? value.replaceAll('_', ' ')}</Badge>

export function Recall({ canOpen, canResolve }: { canOpen: boolean; canResolve: boolean }) {
  const cache = useQueryClient()
  const [selected, setSelected] = useState('')
  const [opening, setOpening] = useState(false)
  const [section, setSection] = useState<Section>('lots')
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
        setSection('lots')
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

  const open = (id: string) => { setSelected(id); setSection('lots'); setFeedback(null) }
  const caseData = details.data
  const activeCount = cases.data?.filter(row => !row.closed_at).length ?? 0

  return <section className="panel">
    <PageHeader icon={ShieldAlert} title="Recolhimentos"
      description={activeCount ? `${activeCount} ${activeCount === 1 ? 'recolhimento ativo' : 'recolhimentos ativos'}. Lotes afetados ficam bloqueados até a avaliação.`
        : 'Bloqueio de lotes, destinos afetados, ações de contato e encerramento com avaliação sanitária.'}
      actions={canOpen && !opening && <button type="button" onClick={() => { setOpening(true); setFeedback(null) }}>
        <ShieldAlert aria-hidden="true" size={16}/>Abrir recolhimento</button>}/>
    {canOpen && opening && <form className="ui-form ui-detail" aria-labelledby="recall-open-title"
      onSubmit={event => void submit(event, 'open_lot_recall')}>
      <div className="ui-detail-header">
        <h2 id="recall-open-title">Abrir recolhimento</h2>
        <button type="button" className="secondary" disabled={busy} onClick={() => { setOpening(false); setFeedback(null) }}>
          <X aria-hidden="true" size={16}/>Fechar</button>
      </div>
      <p className="ui-message" data-tone="danger">A abertura bloqueia o lote de origem e os derivados identificados. Confira o código antes de confirmar.</p>
      <label>Código interno do lote de origem <input name="lot" autoComplete="off" required/></label>
      <label>Motivo do recolhimento <textarea name="reason" maxLength={1000} required rows={3}/></label>
      <div className="ui-form-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => { setOpening(false); setFeedback(null) }}>Cancelar</button>
        <button disabled={busy}>{busy ? 'Abrindo…' : 'Confirmar abertura e bloqueio'}</button>
      </div>
    </form>}
    {feedback && <p className="ui-message" data-tone={feedback.error ? 'danger' : 'success'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {selected && details.isPending && <Skeleton lines={5} label="Carregando detalhes…"/>}
    {details.isError && <ErrorState title="Falha ao consultar o caso" onRetry={() => void details.refetch()}/>}
    {caseData && <article className="ui-detail" aria-labelledby="recall-title">
      <div className="ui-detail-header">
        <div>
          <h2 id="recall-title">Caso {caseData.case_number}</h2>
          <p className="ui-muted">Origem <span className="ui-code">{caseData.root_code}</span> · aberto em {stamp(caseData.opened_at)}</p>
        </div>
        <span className="ui-cell-stack">
          {caseData.closed_at ? <Badge>Encerrado</Badge> : <Badge tone="danger">Ativo</Badge>}
          <button type="button" className="secondary" onClick={() => setSelected('')}><X aria-hidden="true" size={16}/>Fechar</button>
        </span>
      </div>
      <p>{caseData.reason}</p>
      {caseData.closed_at && <dl>
        <div><dt>Encerrado em</dt><dd>{stamp(caseData.closed_at)}</dd></div>
        <div><dt>Responsável</dt><dd>{caseData.closed_by}</dd></div>
        <div><dt>Avaliação</dt><dd>{caseData.close_reference}</dd></div>
      </dl>}
      {canResolve && !caseData.closed_at && <details>
        <summary>Encerrar recolhimento</summary>
        <p className="ui-muted">O encerramento mantém os lotes bloqueados e as massadas em andamento sem autorização de retomada.</p>
        <form className="ui-inline-form" onSubmit={event => void submit(event, 'close_lot_recall')}>
          <label>Conclusão ou referência da avaliação sanitária <textarea name="evaluation" maxLength={1000} required rows={3}/></label>
          <div><button disabled={busy}>Confirmar encerramento</button></div>
        </form>
      </details>}
      <Tabs label="Seções do recolhimento" value={section} onChange={setSection} items={[
        { id: 'lots', label: `Lotes (${caseData.lots.length})` },
        { id: 'batches', label: `Massadas (${caseData.batches.length})` },
        { id: 'shipments', label: `Destinos (${caseData.shipments.length})` },
        { id: 'actions', label: `Ações (${caseData.actions.length})` },
      ]}/>
      {section === 'lots' && <DataTable caption="Lotes afetados" rows={caseData.lots} rowKey={row => row.code}
        empty={{ title: 'Nenhum lote vinculado' }} columns={[
          { id: 'code', header: 'Lote', cell: row => <span className="ui-code">{row.code}</span> },
          { id: 'status', header: 'Situação', cell: row => <span className="ui-trace-change"><LotBadge value={row.status}/>
            {row.prior_status && row.prior_status !== row.status && <span className="ui-muted">antes: {lotStatusLabels[row.prior_status as LotStatus] ?? row.prior_status}</span>}</span> },
          { id: 'physical', header: 'Saldo físico', align: 'end', cell: row => <strong>{formatStockQuantity(row.physical)} {row.unit}</strong> },
        ]}/>}
      {section === 'batches' && (caseData.batches.length ? <ul className="ui-plain-list ui-recall-batches">{caseData.batches.map(batch =>
        <li key={batch.id}>
          <span className="ui-code">{batch.code}</span> <Badge tone={batch.status === 'FINALIZADA' ? 'success' : 'warning'}>{batch.status.replaceAll('_', ' ')}</Badge>
          {batch.resume_authorized_at && <p className="ui-muted">Retomada autorizada neste caso em {stamp(batch.resume_authorized_at)} · {batch.resume_reference}</p>}
          {!batch.resume_authorized_at && batch.status !== 'FINALIZADA' && <p className="ui-muted">Retomada pendente de avaliação.</p>}
          {canResolve && caseData.closed_at && !batch.resume_authorized_at && batch.status !== 'FINALIZADA' &&
            <details><summary>Avaliar retomada</summary>
              <form className="ui-inline-form" onSubmit={event => void submit(event, 'authorize_recall_batch_resume', batch.id)}>
                <label>Referência da avaliação sanitária <textarea name="evaluation" maxLength={1000} required rows={2}/></label>
                <div><button disabled={busy}>Autorizar retomada neste caso</button></div>
              </form>
            </details>}
        </li>)}</ul> : <p className="ui-muted">Nenhuma massada vinculada.</p>)}
      {section === 'shipments' && <DataTable caption="Destinos afetados" rows={caseData.shipments} rowKey={row => row.id}
        empty={{ title: 'Nenhum despacho vinculado' }} columns={[
          { id: 'order', header: 'Pedido e cliente', cell: row => <span className="ui-cell-stack"><strong>Pedido {row.order_number}</strong><span>{row.customer}</span></span> },
          { id: 'code', header: 'Lote', cell: row => <span className="ui-code">{row.code}</span> },
          { id: 'quantity', header: 'Quantidade', align: 'end', cell: row => formatStockQuantity(row.quantity) + ' ' + row.unit },
          { id: 'dispatched', header: 'Despacho', cell: row => stamp(row.dispatched_at) },
        ]}/>}
      {section === 'actions' && <>
        <form className="ui-inline-form" onSubmit={event => void submit(event, 'record_recall_action')}>
          <label>Despacho vinculado <select name="shipment">
            <option value="">Ação geral</option>
            {caseData.shipments.map(shipment => <option key={shipment.id} value={shipment.id}>
              Pedido {shipment.order_number} · {shipment.customer} · {stamp(shipment.dispatched_at)}
            </option>)}
          </select></label>
          <label>Ação realizada <textarea name="action" maxLength={1000} rows={2} required/></label>
          <div><button disabled={busy}>Registrar ação</button></div>
        </form>
        <DataTable caption="Ações e contatos" rows={caseData.actions} rowKey={row => row.id}
          empty={{ title: 'Nenhuma ação registrada' }} columns={[
            { id: 'when', header: 'Horário e responsável', cell: row => <span className="ui-cell-stack"><span>{stamp(row.recorded_at)}</span><span>{row.operator}</span></span> },
            { id: 'note', header: 'Ação', cell: row => row.note },
            { id: 'shipment', header: 'Despacho', cell: row => {
              const shipment = caseData.shipments.find(item => item.id === row.shipment_id)
              return shipment ? 'Pedido ' + shipment.order_number + ' · ' + shipment.customer : 'Ação geral'
            } },
          ]}/>
      </>}
    </article>}
    <DataTable caption="Recolhimentos" rows={cases.data} columns={caseColumns} rowKey={row => row.id}
      loading={cases.isPending} error={cases.isError} onRetry={() => void cases.refetch()}
      empty={{ title: 'Nenhum recolhimento cadastrado', description: 'Quando um lote precisar ser recolhido, abra o caso por aqui.' }}
      onRowOpen={row => open(row.id)}
      rowActions={row => <button type="button" className="secondary" disabled={busy} onClick={() => open(row.id)}>
        {row.id === selected ? 'Aberto' : 'Abrir'}</button>}/>
  </section>
}
