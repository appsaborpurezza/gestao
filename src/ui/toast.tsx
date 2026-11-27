import { useEffect, useState } from 'react'
import { CheckCircle2, AlertCircle, X } from 'lucide-react'

type Toast = { id: number; text: string; tone: 'success' | 'danger' | 'info' }
let next = 0
const listeners = new Set<(toasts: Toast[]) => void>()
let current: Toast[] = []

function publish(list: Toast[]) {
  current = list
  listeners.forEach(listener => listener(current))
}

/** Aviso discreto após a resposta definitiva do servidor. Some sozinho em 5 s. */
export function toast(text: string, tone: Toast['tone'] = 'success') {
  const item = { id: ++next, text, tone }
  publish([...current.slice(-2), item])
  window.setTimeout(() => publish(current.filter(entry => entry.id !== item.id)), 5000)
}

export function Toaster() {
  const [toasts, setToasts] = useState(current)
  useEffect(() => { listeners.add(setToasts); return () => { listeners.delete(setToasts) } }, [])
  return <div className="ui-toaster" role="status" aria-live="polite">
    {toasts.map(item => <div key={item.id} className="ui-toast" data-tone={item.tone}>
      {item.tone === 'danger' ? <AlertCircle aria-hidden="true" size={18}/> : <CheckCircle2 aria-hidden="true" size={18}/>}
      <span>{item.text}</span>
      <button type="button" className="icon-button" aria-label="Fechar aviso" onClick={() => publish(current.filter(entry => entry.id !== item.id))}>
        <X aria-hidden="true" size={16}/>
      </button>
    </div>)}
  </div>
}
