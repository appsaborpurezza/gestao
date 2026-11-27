import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { Batch, Stage } from './ProductionBoard'
import { batchState } from './ProductionBoard'
import { useBoardRealtime } from './useBoardRealtime'

export type BoardState = 'running' | 'paused' | 'waiting' | 'blocked'
export type BoardFilters = {
  search: string; states: BoardState[]; deadline: '' | 'late' | 'soon' | 'today' | 'week'
  delivery_from: string; delivery_to: string; production_number: string
}
export type BoardSort = 'delivery' | 'op' | 'stage_time' | 'recent'
export const emptyBoardFilters: BoardFilters = { search: '', states: [], deadline: '', delivery_from: '', delivery_to: '', production_number: '' }

export type BoardBatch = Batch & { planned_kg: number; actual_kg: number | null }
export type BoardSummary = {
  active: number; active_kg: number; running: number; paused: number; waiting: number; blocked: number
  late: number; soon: number; finished_today: number; finished_today_kg: number; finished_total: number
}
export type BoardGroup = {
  production_number: number; description: string; customer_name: string; order_number: number; delivery_date: string
  batches_count: number; done: number; planned_kg: number; produced_kg: number; blocked: number; paused: number; late: boolean
  by_stage: Partial<Record<Stage, number>>
}
export type BoardResult = {
  columns: Record<Stage, { total: number; kg: number; rows: BoardBatch[] }>
  summary: BoardSummary; groups: BoardGroup[]; today: string
}

/** Filtros no formato da RPC: só envia o que está preenchido. */
export function boardFilterPayload(filters: BoardFilters) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => Array.isArray(value) ? value.length : value !== ''))
}

async function fetchBoard(pageSize: number, offsets: Partial<Record<Stage, number>>, filters: BoardFilters, sort: BoardSort, signal?: AbortSignal) {
  const request = supabase.rpc('production_board_query', {
    page_size: pageSize, page_offsets: offsets, filters: boardFilterPayload(filters), sort,
  })
  const { data, error } = await (signal ? request.abortSignal(signal) : request)
  if (error) throw error
  return data as BoardResult
}

/**
 * Consulta do quadro com filtros, ordenação, totais em kg e indicadores calculados no servidor.
 * A chave começa com ['production-board','columns'], que é o que o Realtime invalida.
 */
export function useBoardQuery(pageSize: number, offsets: Partial<Record<Stage, number>>, filters: BoardFilters, sort: BoardSort) {
  const realtime = useBoardRealtime()
  const board = useQuery({
    queryKey: ['production-board', 'columns', 'v2', pageSize, offsets, filters, sort],
    placeholderData: keepPreviousData,
    refetchInterval: realtime ? 300_000 : 60_000,
    queryFn: ({ signal }) => fetchBoard(pageSize, offsets, filters, sort, signal),
  })
  return { board, realtime }
}

/** Visão sem filtros para terminal e TV: totais e indicadores sempre do quadro inteiro. */
export function useBoardSnapshot(pageSize: number) {
  return useBoardQuery(pageSize, {}, emptyBoardFilters, 'delivery')
}

/**
 * Fila do terminal com carregamento incremental: cada página traz até 30 massadas da estação,
 * na ordem da fila. "Carregar mais" busca a próxima página sem recarregar as anteriores.
 */
export function useStationQueue(station: Stage | null) {
  const realtime = useBoardRealtime()
  const size = 30
  const query = useInfiniteQuery({
    queryKey: ['production-board', 'columns', 'station', station],
    enabled: station !== null,
    initialPageParam: 0,
    refetchInterval: realtime ? 300_000 : 60_000,
    queryFn: ({ pageParam, signal }) => fetchBoard(size, { [station!]: pageParam }, emptyBoardFilters, 'delivery', signal),
    getNextPageParam: (last, pages) => {
      const loaded = pages.length * size
      return station && loaded < last.columns[station].total ? loaded : undefined
    },
  })
  const first = query.data?.pages[0]
  const rows = station ? query.data?.pages.flatMap(page => page.columns[station].rows) ?? [] : []
  return { query, realtime, first, rows: stationQueue(rows) as BoardBatch[], total: station && first ? first.columns[station].total : 0 }
}

const priority = { running: 0, paused: 1, waiting: 2, blocked: 3, done: 4 } as const

/** Próxima atividade primeiro: em execução, pausada, aguardando (por prazo); bloqueadas por último. */
export function stationQueue<T extends Batch>(rows: T[]) {
  return [...rows].sort((a, b) => priority[batchState(a)] - priority[batchState(b)]
    || a.delivery_date.localeCompare(b.delivery_date) || a.production_number - b.production_number || a.sequence - b.sequence)
}

const kgFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })
export const formatKg = (value: number | string | null | undefined) => kgFormat.format(Number(value ?? 0)) + ' kg'
