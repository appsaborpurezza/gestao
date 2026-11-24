import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { parseLotCode } from './lotCode'
import { formatStockQuantity } from '../../lib/decimal'

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

  return <section>
    <h2>Sessões de inventário</h2>
    {locations.length > 0 && <form onSubmit={async event => {
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
      <button disabled={busy}>Abrir sessão</button>
    </form>}
    {sessions.isPending && <p role="status">Carregando sessões…</p>}
    {sessions.isError && <p role="alert">Falha ao consultar sessões.</p>}
    {sessions.data?.length === 0 && <p>Nenhuma sessão cadastrada.</p>}
    {!!sessions.data?.length && <label>Sessões abertas e encerradas recentemente
      <select value={selected} onChange={event => { setSelected(event.target.value); setError('') }}>
        <option value="">Selecione</option>
        {sessions.data.map(row => <option key={row.id} value={row.id}>
          {locations.find(location => location.id === row.location_id)?.code ?? 'Local inativo'} · {date.format(new Date(row.opened_at))} · {row.closed_at ? 'Encerrada' : 'Aberta'}
        </option>)}
      </select>
    </label>}
    {session && <article>
      <h3>{session.reason}</h3>
      {session.closed_at && <p>Encerrada em {date.format(new Date(session.closed_at))} · {session.close_reason}</p>}
      {!session.closed_at && <form onSubmit={addCount}>
        <label>Código interno do lote <input name="lot" autoComplete="off" required/></label>
        <label>Quantidade física na unidade base do lote <input name="amount" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?" required/></label>
        <label>Motivo da contagem <input name="reason" required/></label>
        <button disabled={busy || finding}>Registrar contagem na sessão</button>
      </form>}
      {error && <p role="alert">{error}</p>}
      {counts.isPending && <p role="status">Carregando contagens…</p>}
      {counts.isError && <p role="alert">Falha ao consultar contagens.</p>}
      {counts.data?.length === 0 && <p>Nenhuma contagem registrada nesta sessão.</p>}
      {counts.data?.map(count => <article key={count.id}>
        <h4>{count.lot?.original_lot} · {count.lot?.internal_code}</h4>
        <p>Saldo registrado {formatStockQuantity(String(count.expected_quantity))} · Contagem {formatStockQuantity(String(count.counted_quantity))} {count.lot?.unit}</p>
        <p>{count.reason} · {count.decision ?? 'PENDENTE'}{count.review_reason && ' · ' + count.review_reason}</p>
        {admin && !count.decision && <form onSubmit={event => {
          event.preventDefault()
          const fields = new FormData(event.currentTarget)
          void mutate('review_inventory_count', {
            target_count: count.id, approve: fields.get('decision') === 'approve', reason: fields.get('reason'),
          }, 'Revisão registrada.')
        }}>
          <label>Decisão <select name="decision" required><option value="">Selecione</option>
            <option value="approve">Aprovar ajuste</option><option value="reject">Rejeitar contagem</option>
          </select></label>
          <label>Justificativa <input name="reason" required/></label>
          <button disabled={busy}>Confirmar decisão</button>
        </form>}
      </article>)}
      {admin && !session.closed_at && counts.data && counts.data.every(count => count.decision !== null) &&
        <form onSubmit={event => {
          event.preventDefault()
          const fields = new FormData(event.currentTarget)
          void mutate('close_inventory_session', {
            target_session: session.id, reason: fields.get('reason'),
          }, 'Sessão encerrada.')
        }}>
          <label>Motivo do encerramento <input name="reason" required/></label>
          <button disabled={busy}>Encerrar sessão</button>
        </form>}
    </article>}
  </section>
}
