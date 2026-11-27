import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'

let channelSeq = 0

export function useBoardRealtime() {
  const cache = useQueryClient()
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let active = true
    let timer: number | undefined
    let dirty = false
    const reconcile = () => {
      if (!active) return
      dirty = true
      if (document.hidden || timer !== undefined) return
      timer = window.setTimeout(() => {
        timer = undefined
        if (!active || document.hidden) return
        dirty = false
        void cache.invalidateQueries({ queryKey: ['production-board', 'columns'] })
      }, 300)
    }
    const onVisibility = () => {
      if (!document.hidden && dirty) reconcile()
    }
    document.addEventListener('visibilitychange', onVisibility)
    const channel = supabase.channel('production-board-revision-' + ++channelSeq)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'production_board_revision' }, reconcile)
      .subscribe(status => {
        if (!active) return
        setConnected(status === 'SUBSCRIBED')
        if (status === 'SUBSCRIBED') reconcile()
      })
    return () => {
      active = false
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      void supabase.removeChannel(channel)
    }
  }, [cache])

  return connected
}
