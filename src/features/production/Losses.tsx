import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatStockQuantity } from '../../lib/decimal'
import { supabase } from '../../lib/supabase'
import { useLossMutation, useLossOptions } from './lossSupport'
import { StockWasteHistory } from '../inventory/StockWaste'

const operations = {
  PREPARACAO: 'Preparação', BATER_MASSA: 'Bater massa', CILINDROS: 'Cilindros', EMBALAGEM: 'Embalagem', OUTRA: 'Outra operação',
} as const
export type LossOperation = keyof typeof operations
const saoPaulo = 'America/Sao_Paulo'
const dateTime = new Intl.DateTimeFormat('pt-BR', { timeZone: saoPaulo, dateStyle: 'short', timeStyle: 'short' })
const localDay = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: saoPaulo, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())
const pageSize = 20

export function MassLossForm({ batch }: { batch?: { id: string; operation: Exclude<LossOperation, 'OUTRA'> } }) {
  const options = useLossOptions()
  const mutation = useLossMutation('record_mass_loss')
  const versions = useQuery({
    queryKey: ['recipes', 'loss-options'],
    enabled: !batch,
    queryFn: async () => {
      const { data, error } = await supabase.from('recipes').select('name,recipe_versions(id,version)').order('name')
      if (error) throw error
      return data.flatMap(recipe => recipe.recipe_versions.map(version => ({
        id: version.id, label: recipe.name + ' · versão ' + version.version,
      })))
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    void mutation.run({ input: {
      batch_id: batch?.id ?? null, operation: batch?.operation ?? fields.get('operation'),
      recipe_version_id: fields.get('recipe'), quantity_kg: String(fields.get('quantity')).replace(',', '.'),
      reason_id: fields.get('reason'), destination_id: fields.get('destination'),
      occurred_local: fields.get('occurred'), notes: fields.get('notes'),
    } }, form, 'Perda registrada.')
  }

  return <>
    {options.isPending && <p role="status">Carregando motivos e destinações…</p>}
    {options.isError && <p role="alert">Falha ao consultar os cadastros de perdas.</p>}
    {options.data?.destinations.length === 0 && <p>Cadastre uma destinação autorizada para registrar perdas.</p>}
    {!!options.data?.destinations.length && <form onSubmit={submit}>
      {!batch && <>
        <label>Operação <select name="operation" required><option value="">Selecione</option>
          {Object.entries(operations).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>Receita, se conhecida <select name="recipe"><option value="">Não informada</option>
          {versions.data?.map(version => <option key={version.id} value={version.id}>{version.label}</option>)}
        </select></label>
        {versions.isError && <p role="alert">Falha ao consultar receitas.</p>}
      </>}
      <label>Massa desperdiçada (kg) <input name="quantity" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?" required/></label>
      <label>Motivo <select name="reason" required><option value="">Selecione</option>
        {options.data.reasons.filter(row => row.active).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></label>
      <label>Destinação realizada <select name="destination" required><option value="">Selecione</option>
        {options.data.destinations.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></label>
      {!batch && <label>Data e hora da ocorrência em São Paulo, se diferente da atual
        <input name="occurred" type="datetime-local"/>
      </label>}
      <label>Observações <textarea name="notes" rows={2} maxLength={500}/></label>
      <button disabled={mutation.busy}>{mutation.busy ? 'Registrando…' : 'Registrar perda de massa'}</button>
    </form>}
    {mutation.feedback && <p role={mutation.feedback.error ? 'alert' : 'status'}>{mutation.feedback.text}</p>}
  </>
}

function ConfigureLosses({ canAuthorize }: { canAuthorize: boolean }) {
  const [kind, setKind] = useState<'MOTIVO' | 'DESTINACAO'>('MOTIVO')
  const mutation = useLossMutation('add_loss_option')
  return <details><summary>Configurar motivos e destinações</summary>
    <form onSubmit={event => {
      event.preventDefault()
      const form = event.currentTarget
      const fields = new FormData(form)
      void mutation.run({ kind, label: fields.get('label'), reference: fields.get('reference') }, form, 'Cadastro salvo.')
    }}>
      <label>Tipo de cadastro <select value={kind} onChange={event => setKind(event.target.value === 'DESTINACAO' ? 'DESTINACAO' : 'MOTIVO')}>
        <option value="MOTIVO">Motivo</option>{canAuthorize && <option value="DESTINACAO">Destinação autorizada</option>}
      </select></label>
      <label>Nome <input name="label" maxLength={kind === 'MOTIVO' ? 100 : 120} required/></label>
      {kind === 'DESTINACAO' && <label>Referência da autorização sanitária <input name="reference" maxLength={500} required/></label>}
      <button disabled={mutation.busy}>Salvar cadastro</button>
      {mutation.feedback && <p role={mutation.feedback.error ? 'alert' : 'status'}>{mutation.feedback.text}</p>}
    </form>
  </details>
}

function ReconcileLoss({ id }: { id: string }) {
  const [finding, setFinding] = useState(false)
  const mutation = useLossMutation('reconcile_mass_loss')
  async function reconcile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (finding || mutation.busy) return
    const form = event.currentTarget
    const fields = new FormData(form)
    setFinding(true)
    mutation.setFeedback(null)
    try {
      const { data, error } = await supabase.from('production_batches').select('id')
        .eq('lot_code', String(fields.get('batch')).trim().toUpperCase()).maybeSingle()
      if (error || !data) throw new Error('Nenhuma massada encontrada para este código.')
      await mutation.run({ target_loss: id, target_batch: data.id, target_stage: fields.get('operation'),
        reason: fields.get('reason') }, form, 'Perda conciliada.')
    } catch (cause) {
      mutation.setFeedback({ text: cause instanceof Error ? cause.message : 'Falha ao localizar a massada.', error: true })
    } finally {
      setFinding(false)
    }
  }

  return <details><summary>Vincular a uma massada</summary>
    <form onSubmit={reconcile}>
      <label>Código da massada <input name="batch" placeholder="SP-AAAAMMDD-NNNN" required/></label>
      <label>Etapa <select name="operation" required><option value="">Selecione</option>
        {Object.entries(operations).filter(([key]) => key !== 'OUTRA').map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>Justificativa <input name="reason" maxLength={500} required/></label>
      <button disabled={finding || mutation.busy}>Conciliar perda</button>
      {mutation.feedback && <p role={mutation.feedback.error ? 'alert' : 'status'}>{mutation.feedback.text}</p>}
    </form>
  </details>
}

type Report = {
  total: number; total_kg: string; causes: { reason: string; quantity: string }[]
  rows: { id: string; batch_id: string | null; lot_code: string | null; operation: LossOperation; recipe_name: string | null
    quantity: string; reason: string; destination: string; notes: string | null; occurred_at: string; operator: string }[]
}

export function Losses({ admin, canAuthorize }: { admin: boolean; canAuthorize: boolean }) {
  const [view, setView] = useState<'mass' | 'stock'>('mass')
  const today = localDay()
  const [filter, setFilter] = useState({ from_day: today, to_day: today, filter_reason: null as string | null })
  const [page, setPage] = useState(0)
  const options = useLossOptions()
  const history = useQuery({
    queryKey: ['losses', 'history', filter, page],
    enabled: view === 'mass',
    queryFn: async () => {
      const { data, error } = await supabase.rpc('mass_loss_history', { ...filter, page_size: pageSize, page_offset: page * pageSize })
      if (error) throw error
      return data as Report
    },
  })

  return <section className="panel">
    <h1>Desperdícios</h1>
    <nav aria-label="Tipos de desperdício">
      <button type="button" aria-pressed={view === 'mass'} onClick={() => setView('mass')}>Perdas de massa</button>
      <button type="button" aria-pressed={view === 'stock'} onClick={() => setView('stock')}>Descartes de estoque</button>
    </nav>
    {admin && <ConfigureLosses canAuthorize={canAuthorize}/>}
    {view === 'stock' ? <StockWasteHistory/> : <>
    <details><summary>Registrar perda sem massada</summary><MassLossForm/></details>
    <h2>Histórico de perdas de massa</h2>
    <form onSubmit={event => {
      event.preventDefault()
      const fields = new FormData(event.currentTarget)
      setFilter({ from_day: String(fields.get('from')), to_day: String(fields.get('to')), filter_reason: String(fields.get('reason') ?? '') || null })
      setPage(0)
    }}>
      <div className="customer-fields">
        <label>De <input name="from" type="date" defaultValue={today} max={today} required/></label>
        <label>Até <input name="to" type="date" defaultValue={today} max={today} required/></label>
        <label>Motivo <select name="reason"><option value="">Todos</option>
          {options.data?.reasons.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select></label>
      </div>
      <button>Consultar histórico</button>
    </form>
    {history.isPending && <p role="status">Carregando perdas…</p>}
    {history.isError && <p role="alert">Falha ao consultar perdas. Confira o período informado.</p>}
    {history.data && <>
      <p>{history.data.total} registros · {formatStockQuantity(history.data.total_kg)} kg de perdas registradas</p>
      {history.data.causes.length > 0 && <ul aria-label="Total por causa">{history.data.causes.map(cause => <li key={cause.reason}>
        {cause.reason} · {formatStockQuantity(cause.quantity)} kg
      </li>)}</ul>}
      {history.data.rows.map(row => <article key={row.id}>
        <h3>{formatStockQuantity(row.quantity)} kg · {row.reason}</h3>
        <p>{dateTime.format(new Date(row.occurred_at))} · {row.operator} · {operations[row.operation]}</p>
        <p>{row.lot_code ?? 'Sem massada identificada'} · {row.recipe_name ?? 'Receita não informada'} · {row.destination}</p>
        {row.notes && <p>{row.notes}</p>}
        {admin && !row.batch_id && <ReconcileLoss id={row.id}/>}
      </article>)}
      {(history.data.total > pageSize || page > 0) && <nav aria-label="Páginas de perdas">
        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
        <span>Página {page + 1}</span>
        <button type="button" disabled={(page + 1) * pageSize >= history.data.total} onClick={() => setPage(page + 1)}>Próxima</button>
      </nav>}
    </>}
    </>}
  </section>
}
