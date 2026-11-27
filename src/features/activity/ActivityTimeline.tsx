import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { historyLabels } from '../../lib/catalog'
import { EmptyState, ErrorState, PageHeader, Skeleton } from '../../ui'
import { FilterBar, useSessionState } from '../../ui/filters'
import { SavedViews } from '../../ui/SavedViews'

type Entry = { id: string; created_at: string; action: string; actor: string | null; actor_id: string; details: Record<string, unknown> }
type Filters = { actor: string; action: string; from: string; to: string }
const empty: Filters = { actor: '', action: '', from: '', to: '' }
const pageSize = 50
const dayFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeZone: 'America/Sao_Paulo' })
const timeFormat = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone: 'America/Sao_Paulo' })
const entityLabels: Record<string, string> = {
  CLIENTE: 'Cliente', PRODUTO: 'Produto', INSUMO: 'Insumo', FORNECEDOR: 'Fornecedor', FABRICANTE: 'Fabricante', LOCAL: 'Local',
  MOTIVO_PERDA: 'Motivo de perda', DESTINACAO_PERDA: 'Destinação', VERSAO_RECEITA: 'Versão de receita', RECEITA: 'Receita',
  CONFIG_EMBALAGEM: 'Embalagem', CONVERSAO_UNIDADE: 'Conversão de unidade',
}
export const actionLabel = (action: string) => historyLabels[action] ?? action.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

/** Resumo legível dos detalhes da auditoria, sem exibir JSON cru ao usuário. */
export function describe(details: Record<string, unknown>) {
  const parts: string[] = []
  const entity = typeof details.entidade === 'string' ? entityLabels[details.entidade] ?? details.entidade : null
  const record = details.registro as Record<string, unknown> | undefined
  const name = record && (record.nome ?? record.codigo ?? record.name)
  if (entity) parts.push(entity + (name ? `: ${String(name)}` : ''))
  const after = details.depois as Record<string, unknown> | undefined
  const before = details.antes as Record<string, unknown> | undefined
  if (before?.nome && after?.nome && before.nome !== after.nome) parts.push(`${String(before.nome)} → ${String(after.nome)}`)
  if (typeof details.justificativa === 'string') parts.push(`Justificativa: ${details.justificativa}`)
  for (const key of ['order_number', 'pedido', 'production_number', 'lot_code', 'internal_code', 'email']) {
    if (details[key] !== undefined && details[key] !== null) parts.push(`${key === 'email' ? 'E-mail' : key.replace(/_/g, ' ')}: ${String(details[key])}`)
  }
  return parts.join(' · ')
}

export default function ActivityTimeline() {
  const [filters, setFilters] = useSessionState<Filters>('activity', empty)
  const actions = useQuery({
    queryKey: ['activity', 'actions'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('activity_actions')
      if (error) throw error
      return data as string[]
    },
  })
  const people = useQuery({
    queryKey: ['activity', 'people'],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('id,display_name').order('display_name')
      if (error) throw error
      return data as { id: string; display_name: string }[]
    },
  })
  const timeline = useInfiniteQuery({
    queryKey: ['activity', 'timeline', filters],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const payload = Object.fromEntries(Object.entries(filters).filter(([, value]) => value))
      const { data, error } = await supabase.rpc('activity_timeline', { filters: payload, before_at: pageParam, page_size: pageSize }).abortSignal(signal)
      if (error) throw new Error(error.code === '22023' ? error.message : 'Não foi possível carregar a linha do tempo.')
      return data as Entry[]
    },
    getNextPageParam: last => last.length === pageSize ? last.at(-1)!.created_at : undefined,
  })
  const entries = timeline.data?.pages.flat() ?? []
  const days = new Map<string, Entry[]>()
  for (const entry of entries) {
    const raw = dayFormat.format(new Date(entry.created_at))
    const day = raw.charAt(0).toUpperCase() + raw.slice(1)
    days.set(day, [...(days.get(day) ?? []), entry])
  }
  const active = Object.values(filters).filter(Boolean).length

  return <section className="panel">
    <PageHeader icon={History} title="Linha do tempo" description="Tudo o que foi registrado na auditoria, do mais recente para o mais antigo."/>
    <FilterBar activeCount={active} onClear={() => setFilters(empty)} onRefresh={() => void timeline.refetch()} refreshing={timeline.isFetching}>
      <label>Ação <select value={filters.action} onChange={event => setFilters({ ...filters, action: event.target.value })}>
        <option value="">Todas</option>{actions.data?.map(action => <option key={action} value={action}>{actionLabel(action)}</option>)}
      </select></label>
      <label>Usuário <select value={filters.actor} onChange={event => setFilters({ ...filters, actor: event.target.value })}>
        <option value="">Todos</option>{people.data?.map(person => <option key={person.id} value={person.id}>{person.display_name}</option>)}
      </select></label>
      <label>De <input type="date" value={filters.from} max={filters.to || undefined} onChange={event => setFilters({ ...filters, from: event.target.value })}/></label>
      <label>Até <input type="date" value={filters.to} min={filters.from || undefined} onChange={event => setFilters({ ...filters, to: event.target.value })}/></label>
    </FilterBar>
    <SavedViews<Filters> scope="activity" current={filters} onApply={setFilters} presets={[{ id: 'tudo', label: 'Tudo', filters: empty }]}/>
    {timeline.isPending && <Skeleton lines={6} label="Carregando linha do tempo…"/>}
    {timeline.isError && <ErrorState title="Falha ao carregar a linha do tempo" description={timeline.error.message} onRetry={() => void timeline.refetch()}/>}
    {timeline.isSuccess && !entries.length && <EmptyState icon={History} title="Nenhuma atividade" description="Ajuste os filtros para ver outros registros."/>}
    {[...days].map(([day, list]) => <section key={day} className="activity-day" aria-label={day}>
      <h2>{day}</h2>
      <ol className="activity-list">{list.map(entry => <li key={entry.id}>
        <time dateTime={entry.created_at}>{timeFormat.format(new Date(entry.created_at))}</time>
        <div><strong>{actionLabel(entry.action)}</strong> <span className="ui-muted">por {entry.actor ?? 'usuário removido'}</span>
          {describe(entry.details) && <p>{describe(entry.details)}</p>}</div>
      </li>)}</ol>
    </section>)}
    {timeline.hasNextPage && <div className="terminal-more"><button type="button" className="secondary" disabled={timeline.isFetchingNextPage}
      onClick={() => void timeline.fetchNextPage()}>{timeline.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}</button></div>}
  </section>
}
