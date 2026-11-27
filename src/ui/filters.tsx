import { useEffect, useState, type ReactNode } from 'react'
import { CalendarRange, FilterX, RefreshCw, Search, X } from 'lucide-react'
import { periodPresets, resolvePeriod, todayInSaoPaulo, type Period, type PeriodPreset } from '../lib/periods'

export function useDebouncedValue<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/** Estado de filtros preservado na sessão da aba, para manter a consulta ao abrir um registro e voltar. */
export function useSessionState<T>(key: string, initial: T) {
  const storageKey = 'purezza:filters:' + key
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      return saved ? { ...initial, ...JSON.parse(saved) } as T : initial
    } catch { return initial }
  })
  useEffect(() => { try { sessionStorage.setItem(storageKey, JSON.stringify(value)) } catch { /* armazenamento indisponível */ } }, [storageKey, value])
  return [value, setValue] as const
}

export function SearchInput({ value, onChange, label, placeholder }: {
  value: string; onChange: (value: string) => void; label: string; placeholder?: string
}) {
  return <label className="ui-search">
    <span className="sr-only">{label}</span>
    <Search aria-hidden="true" size={18}/>
    <input type="search" value={value} maxLength={120} placeholder={placeholder ?? label} onChange={event => onChange(event.target.value)}/>
    {value && <button type="button" className="icon-button" aria-label="Limpar pesquisa" onClick={() => onChange('')}><X aria-hidden="true" size={16}/></button>}
  </label>
}

export function PeriodFilter({ value, onChange }: { value: Period & { preset?: PeriodPreset | 'custom' }; onChange: (value: Period & { preset?: PeriodPreset | 'custom' }) => void }) {
  return <fieldset className="ui-period">
    <legend className="sr-only">Período</legend>
    <CalendarRange aria-hidden="true" size={18}/>
    <select aria-label="Período" value={value.preset ?? 'custom'} onChange={event => {
      const preset = event.target.value as PeriodPreset | 'custom'
      onChange(preset === 'custom' ? { ...value, preset } : { ...resolvePeriod(preset, todayInSaoPaulo()), preset })
    }}>
      {periodPresets.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      <option value="custom">Período personalizado</option>
    </select>
    {value.preset === 'custom' && <>
      <input type="date" aria-label="Data inicial" value={value.from} max={value.to} onChange={event => onChange({ ...value, from: event.target.value })}/>
      <input type="date" aria-label="Data final" value={value.to} min={value.from} onChange={event => onChange({ ...value, to: event.target.value })}/>
    </>}
  </fieldset>
}

export function FilterBar({ children, activeCount, onClear, onRefresh, refreshing, actions }: {
  children: ReactNode; activeCount: number; onClear?: () => void; onRefresh?: () => void; refreshing?: boolean; actions?: ReactNode
}) {
  return <div className="ui-filterbar" role="search">
    <div className="ui-filterbar-fields">{children}</div>
    <div className="ui-filterbar-actions">
      {activeCount > 0 && <span className="ui-badge" data-tone="info">{activeCount} {activeCount === 1 ? 'filtro ativo' : 'filtros ativos'}</span>}
      {activeCount > 0 && onClear && <button type="button" className="secondary" onClick={onClear}><FilterX aria-hidden="true" size={16}/>Limpar</button>}
      {onRefresh && <button type="button" className="secondary" disabled={refreshing} onClick={onRefresh}>
        <RefreshCw aria-hidden="true" size={16} className={refreshing ? 'access-spinner' : undefined}/>Atualizar
      </button>}
      {actions}
    </div>
  </div>
}
