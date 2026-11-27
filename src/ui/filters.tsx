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

export function PeriodFilter({ value, onChange, label = 'Período' }: {
  value: Period & { preset?: string }; onChange: (value: Period & { preset?: string }) => void; label?: string
}) {
  const preset = value.preset || (value.from || value.to ? 'custom' : '')
  return <fieldset className="ui-period">
    <legend className="sr-only">{label}</legend>
    <CalendarRange aria-hidden="true" size={18}/>
    <select aria-label={label} value={preset} onChange={event => {
      const next = event.target.value
      if (!next) onChange({ from: '', to: '', preset: '' })
      else if (next === 'custom') onChange({ ...value, preset: 'custom' })
      else onChange({ ...resolvePeriod(next as PeriodPreset, todayInSaoPaulo()), preset: next })
    }}>
      <option value="">{label}: qualquer data</option>
      {periodPresets.map(([id, text]) => <option key={id} value={id}>{label}: {text.toLowerCase()}</option>)}
      <option value="custom">{label}: período personalizado</option>
    </select>
    {preset === 'custom' && <>
      <input type="date" aria-label={label + ' — data inicial'} value={value.from} max={value.to || undefined} onChange={event => onChange({ ...value, from: event.target.value, preset: 'custom' })}/>
      <input type="date" aria-label={label + ' — data final'} value={value.to} min={value.from || undefined} onChange={event => onChange({ ...value, to: event.target.value, preset: 'custom' })}/>
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
