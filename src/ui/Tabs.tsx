import type { ReactNode } from 'react'

export type TabItem<Id extends string> = { id: Id; label: ReactNode; hidden?: boolean }

/** Abas de seção dentro de um módulo. Mantém botões com aria-pressed para compatibilidade com testes. */
export function Tabs<Id extends string>({ label, items, value, onChange }: {
  label: string; items: TabItem<Id>[]; value: Id; onChange: (id: Id) => void
}) {
  return <nav className="ui-tabs" aria-label={label}>
    {items.filter(item => !item.hidden).map(item => <button key={item.id} type="button"
      aria-pressed={value === item.id} onClick={() => onChange(item.id)}>{item.label}</button>)}
  </nav>
}
