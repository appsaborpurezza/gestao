import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { parseLotCode } from './lotCode'
import { formatStockQuantity } from '../../lib/decimal'
import { X } from 'lucide-react'
import { Badge } from '../../ui'
import { DataTable, type Column } from '../../ui/DataTable'

type Location = { id: string; code: string }
type Props = {
  admin: boolean
  busy: boolean
  locations: Location[]
  mutate: (operation: string, payload: Record<string, unknown>, success: string) => Promise<boolean>
}
const date = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo',
})

export function InventorySessions({ admin, busy, locations, mutate }: Props) {
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [finding, setFinding] = useState(false)
  const [reviewing, setReviewing] = useState('')
  const sessions = useQuery({
    queryKey: ['inventory', 'sessions'],
    queryFn: async () => {
      const [open, closed] = await Promise.all([
        supabase.from('inventory_sessions').select('id,location_id,reason,opened_at,closed_at,close_reason')
          .is('closed_at', null).order('opened_at', { ascending: false }),
        supabase.from('inventory_sessions').select('id,location_id,reason,opened_at,closed_at,close_reason')
          .not('closed_at', 'is', null).order('closed_at', { ascending: false }).limit(20),
      ])
      if (open.error) throw open.error
      if (closed.error) throw closed.error
      return [...open.data, ...closed.data]
    },
  })
  const session = sessions.data?.find(row => row.id === selected)
  const counts = useQuery({
    queryKey: ['inventory', 'session-counts', selected],
    enabled: Boolean(session),
    queryFn: async () => {
      const { data, error } = await supabase.from('inventory_counts')
        .select('id,expected_quantity,counted_quantity,decision,reason,review_reason,inventory_lots(internal_code,original_lot,unit)')
        .eq('session_id', selected).order('counted_at')
      if (error) throw error
      return data.map(row => ({ ...row,
        lot: row.inventory_lots as unknown as { internal_code: string; original_lot: string; unit: string } | null,
      }))
    },
  })

  async function addCount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session || finding || busy) return
    const form = event.currentTarget
    const values = new FormData(form)
    const code = parseLotCode(String(values.get('lot') ?? ''))
    setError('')
    if (!code) {
      setError('Informe um código interno de lote válido.')
      return
    }
    setFinding(true)
    try {
      const { data, error } = await supabase.from('inventory_lots').select('id')
        .eq('internal_code', code).maybeSingle()
      if (error) throw error
      if (!data) {
        setError('Nenhum lote encontrado para este código.')
        return
      }
      const saved = await mutate('record_session_count', {
        target_session: session.id,
        target_lot: data.id,
        amount: String(values.get('amount')).replace(',', '.'),
        reason: values.get('reason'),
      }, 'Contagem registrada para revisão.')
      if (saved) form.reset()
    } catch {
      setError('Falha ao localizar o lote.')
    } finally {
      setFinding(false)
    }
  }

  type SessionRow = NonNullable<typeof sessions.data>[number]
  type CountRow = NonNullable<typeof counts.data>[number]
  const locationCode = (id: string) => locations.find(location => location.id === id)?.code ?? 'Local inativo'
  const sessionColumns: Column<SessionRow>[] = [
    { id: 'location', header: 'Local', cell: row => <strong>{locationCode(row.location_id)}</strong>, sortValue: row => locationCode(row.location_id) },
    { id: 'reason', header: 'Motivo', cell: row => row.reason },
    { id: 'opened', header: 'Aberta em', cell: row => date.format(new Date(row.opened_at)), sortValue: row => row.opened_at },
    { id: 'status', header: 'Situação', cell: row => row.closed_at
      ? <Badge>Encerrada {date.format(new Date(row.closed_at))}</Badge> : <Badge tone="info">Aberta</Badge> },
  ]
  const decisionBadge = (row: CountRow) => row.decision === null ? <Badge tone="warning">Pendente</Badge>
    : <Badge tone={String(row.decision).startsWith('APROV') ? 'success' : 'neutral'}>{String(row.decision).replaceAll('_', ' ')}</Badge>
  const countColumns: Column<CountRow>[] = [
    { id: 'lot', header: 'Lote', cell: row => <span className="ui-cell-stack"><strong>{row.lot?.original_lot}</strong><span className="ui-code">{row.lot?.internal_code}</span></span> },
    { id: 'expected', header: 'Saldo registrado', align: 'end', cell: row => formatStockQuantity(String(row.expected_quantity)) + ' ' + (row.lot?.unit ?? '') },
    { id: 'counted', header: 'Contagem', align: 'end', cell: row => <strong>{formatStockQuantity(String(row.counted_quantity))} {row.lot?.unit}</strong> },
    { id: 'difference', header: 'Diferença', align: 'end', cell: row => {
      const difference = Number(row.counted_quantity) - Number(row.expected_quantity)
      return <Badge tone={difference === 0 ? 'success' : 'warning'}>{difference > 0 ? '+' : ''}{formatStockQuantity(String(difference))}</Badge>
    } },
    { id: 'decision', header: 'Decisão', cell: row => <span className="ui-cell-stack">{decisionBadge(row)}
      <span>{row.reason}{row.review_reason && ' · ' + row.review_reason}</span></span> },
  ]
  const pendingCount = counts.data?.find(row => row.id === reviewing && row.decision === null)

  return <section aria-labelledby="inventory-sessions-title">
    <h2 id="inventory-sessions-title" className="sr-only">Sessões de inventário</h2>
    {locations.length > 0 && <form className="ui-inline-form ui-session-open" onSubmit={async event => {
      event.preventDefault()
      const form = event.currentTarget
      const values = new FormData(form)
      if (await mutate('open_inventory_session', {
        target_location: values.get('location'), reason: values.get('reason'),
      }, 'Sessão de inventário aberta.')) form.reset()
    }}>
      <label>Local da nova sessão <select name="location" required><option value="">Selecione</option>
        {locations.map(row => <option key={row.id} value={row.id}>{row.code}</option>)}
      </select></label>
      <label>Motivo <input name="reason" required/></label>
      <div><button disabled={busy}>Abrir sessão</button></div>
    </form>}
    {session && <article className="ui-detail" aria-labelledby="session-title">
      <div className="ui-detail-header">
        <div>
          <h3 id="session-title">{locationCode(session.location_id)} · {session.reason}</h3>
          <p className="ui-muted">Aberta em {date.format(new Date(session.opened_at))}
            {session.closed_at && <> · encerrada em {date.format(new Date(session.closed_at))} · {session.close_reason}</>}</p>
        </div>
        <span className="ui-cell-stack">
          {session.closed_at ? <Badge>Encerrada</Badge> : <Badge tone="info">Aberta</Badge>}
          <button type="button" className="secondary" onClick={() => { setSelected(''); setReviewing('') }}><X aria-hidden="true" size={16}/>Fechar</button>
        </span>
      </div>
      {!session.closed_at && <form className="ui-inline-form" onSubmit={addCount}>
        <label>Código interno do lote <input name="lot" autoComplete="off" required/></label>
        <label>Quantidade física na unidade base do lote <input name="amount" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?" required/></label>
        <label>Motivo da contagem <input name="reason" required/></label>
        <div><button disabled={busy || finding}>{finding ? 'Localizando…' : 'Registrar contagem'}</button></div>
      </form>}
      {error && <p className="ui-message" data-tone="danger" role="alert">{error}</p>}
      {admin && pendingCount && <form className="ui-inline-form ui-session-review" onSubmit={async event => {
        event.preventDefault()
        const fields = new FormData(event.currentTarget)
        if (await mutate('review_inventory_count', {
          target_count: pendingCount.id, approve: fields.get('decision') === 'approve', reason: fields.get('reason'),
        }, 'Revisão registrada.')) setReviewing('')
      }}>
        <p className="ui-muted">Revisão do lote <span className="ui-code">{pendingCount.lot?.internal_code}</span></p>
        <label>Decisão <select name="decision" required><option value="">Selecione</option>
          <option value="approve">Aprovar ajuste</option><option value="reject">Rejeitar contagem</option>
        </select></label>
        <label>Justificativa <input name="reason" required/></label>
        <div><button disabled={busy}>Confirmar decisão</button> <button type="button" className="secondary" onClick={() => setReviewing('')}>Cancelar</button></div>
      </form>}
      <DataTable caption="Contagens da sessão" rows={counts.data} columns={countColumns} rowKey={row => row.id}
        loading={counts.isPending} error={counts.isError} onRetry={() => void counts.refetch()}
        empty={{ title: 'Nenhuma contagem registrada nesta sessão' }}
        rowActions={admin && !session.closed_at ? row => row.decision === null
          ? <button type="button" className="secondary" onClick={() => setReviewing(row.id)}>Revisar</button> : null : undefined}/>
      {admin && !session.closed_at && counts.data && counts.data.every(count => count.decision !== null) &&
        <form className="ui-inline-form" onSubmit={event => {
          event.preventDefault()
          const fields = new FormData(event.currentTarget)
          void mutate('close_inventory_session', {
            target_session: session.id, reason: fields.get('reason'),
          }, 'Sessão encerrada.')
        }}>
          <label>Motivo do encerramento <input name="reason" required/></label>
          <div><button disabled={busy}>Encerrar sessão</button></div>
        </form>}
    </article>}
    <DataTable caption="Sessões abertas e encerradas recentemente" rows={sessions.data} columns={sessionColumns} rowKey={row => row.id}
      loading={sessions.isPending} error={sessions.isError} onRetry={() => void sessions.refetch()}
      empty={{ title: 'Nenhuma sessão cadastrada', description: 'Abra uma sessão para contar os lotes de um local.' }}
      onRowOpen={row => { setSelected(row.id); setError(''); setReviewing('') }}
      rowActions={row => <button type="button" className="secondary" onClick={() => { setSelected(row.id); setError(''); setReviewing('') }}>
        {row.closed_at ? 'Ver' : 'Contar'}</button>}/>
  </section>
}
