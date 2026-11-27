import { useState } from 'react'
import { Bookmark, BookmarkPlus, X } from 'lucide-react'
import { readViews, writeViews, type SavedView } from '../lib/workspace'
import { toast } from './toast'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Visualizações prontas e salvas pelo usuário, em chips. Aplicar uma visualização só troca os filtros:
 * a consulta continua no servidor e as permissões são as mesmas.
 */
export function SavedViews<T>({ scope, current, presets, onApply }: {
  scope: string; current: T; presets: SavedView<T>[]; onApply: (filters: T) => void
}) {
  const [views, setViews] = useState(() => readViews<T>(scope))
  const [naming, setNaming] = useState(false)
  const [label, setLabel] = useState('')
  const save = () => {
    const name = label.trim()
    if (!name) return
    const next = [...views.filter(view => view.label !== name), { id: crypto.randomUUID(), label: name, filters: current }]
    setViews(next); writeViews(scope, next); setNaming(false); setLabel('')
    toast('Visualização salva.')
  }
  const remove = (id: string) => { const next = views.filter(view => view.id !== id); setViews(next); writeViews(scope, next) }
  return <div className="ui-views" role="group" aria-label="Visualizações">
    <Bookmark aria-hidden="true" size={16}/>
    {[...presets, ...views].map(view => {
      const mine = !presets.includes(view)
      return <span key={view.id} className="ui-view-chip" data-active={same(view.filters, current) || undefined}>
        <button type="button" aria-pressed={same(view.filters, current)} onClick={() => onApply(view.filters)}>{view.label}</button>
        {mine && <button type="button" className="ui-view-remove" aria-label={'Excluir visualização ' + view.label} onClick={() => remove(view.id)}>
          <X aria-hidden="true" size={12}/></button>}
      </span>
    })}
    {naming ? <form className="ui-view-new" onSubmit={event => { event.preventDefault(); save() }}>
      <input aria-label="Nome da visualização" value={label} maxLength={40} autoFocus placeholder="Nome da visualização"
        onChange={event => setLabel(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setNaming(false) }}/>
      <button disabled={!label.trim()}>Salvar</button>
      <button type="button" className="secondary" onClick={() => setNaming(false)}>Cancelar</button>
    </form> : <button type="button" className="secondary ui-view-add" onClick={() => setNaming(true)}>
      <BookmarkPlus aria-hidden="true" size={16}/>Salvar visualização</button>}
  </div>
}
