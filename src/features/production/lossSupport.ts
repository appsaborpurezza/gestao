import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'

export function useLossOptions() {
  return useQuery({
    queryKey: ['losses', 'options'],
    queryFn: async () => {
      const [reasons, destinations] = await Promise.all([
        supabase.from('loss_reasons').select('id,name,active').order('name'),
        supabase.from('loss_destinations').select('id,name').eq('active', true).order('name'),
      ])
      if (reasons.error || destinations.error) throw reasons.error ?? destinations.error
      return { reasons: reasons.data!, destinations: destinations.data! }
    },
  })
}

export function useLossMutation(operation: string) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null)
  const working = useRef(false)
  const pending = useRef<{ payload: string; id: string } | null>(null)

  async function run(params: Record<string, unknown>, form: HTMLFormElement, message: string) {
    if (working.current) return
    const payload = JSON.stringify(params)
    if (pending.current?.payload !== payload) pending.current = { payload, id: crypto.randomUUID() }
    working.current = true
    setBusy(true)
    setFeedback(null)
    try {
      const { error } = await supabase.rpc(operation, { ...params, request_id: pending.current.id })
      if (error) throw new Error(error.code === '23505' ? 'Já existe um cadastro com este nome.' : error.message)
      pending.current = null
      form.reset()
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['losses'] }),
        cache.invalidateQueries({ queryKey: operation === 'discard_stock' ? ['inventory'] : ['inventory', 'trace'] }),
      ])
      setFeedback({ text: message, error: false })
    } catch (cause) {
      setFeedback({ text: cause instanceof Error ? cause.message : 'Falha ao gravar o registro.', error: true })
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  return { run, busy, feedback, setFeedback }
}
