import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { Batch, Stage } from './ProductionBoard'
import { batchState } from './ProductionBoard'
import { useBoardRealtime } from './useBoardRealtime'

/**
 * Consulta única do quadro para terminal e TV. O Realtime só invalida esta mesma chave;
 * sem Realtime, atualiza a cada minuto. Nada de consultas por segundo nem assinatura por cartão.
 */
export function useBoardSnapshot(pageSize: number) {
  const realtime = useBoardRealtime()
  const board = useQuery({
    queryKey: ['production-board', 'columns', 'snapshot', pageSize],
    placeholderData: keepPreviousData,
    refetchInterval: realtime ? 300_000 : 60_000,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.rpc('production_board_columns', { page_size: pageSize, page_offsets: {}, search: '' }).abortSignal(signal)
      if (error) throw error
      return data as Record<Stage, { total: number; rows: Batch[] }>
    },
  })
  return { board, realtime }
}

const priority = { running: 0, paused: 1, waiting: 2, blocked: 3, done: 4 } as const

/** Próxima atividade primeiro: em execução, pausada, aguardando (por prazo); bloqueadas por último. */
export function stationQueue(rows: Batch[]) {
  return [...rows].sort((a, b) => priority[batchState(a)] - priority[batchState(b)]
    || a.delivery_date.localeCompare(b.delivery_date) || a.production_number - b.production_number || a.sequence - b.sequence)
}
