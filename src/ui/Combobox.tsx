import { useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { highlightParts, matchesTerm } from '../lib/text'

export type ComboOption = { value: string; label: string; hint?: string; disabled?: boolean }

/** Seleção pesquisável por trecho de nome ou código, com navegação por teclado (padrão ARIA combobox). */
export function Combobox({ label, options, value, onChange, placeholder = 'Pesquise por nome ou código', required, disabled, name, limit = 50 }: {
  label: string; options: ComboOption[]; value: string; onChange: (value: string) => void
  placeholder?: string; required?: boolean; disabled?: boolean; name?: string; limit?: number
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const selected = options.find(option => option.value === value)
  const matches = useMemo(() => options.filter(option => matchesTerm(term, option.label, option.hint)), [options, term])
  const shown = matches.slice(0, limit)

  const choose = (option: ComboOption | undefined) => {
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
    setTerm('')
  }

  return <div className="ui-combobox">
    <label htmlFor={id}>{label}{required && <span aria-hidden="true" className="ui-required"> *</span>}</label>
    <div className="ui-combobox-field" data-open={open}>
      <input ref={input} id={id} role="combobox" aria-expanded={open} aria-controls={id + '-list'} aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${id}-opt-${active}` : undefined}
        aria-required={required} disabled={disabled} autoComplete="off" placeholder={selected ? undefined : placeholder}
        value={open ? term : selected?.label ?? ''}
        onFocus={() => { setOpen(true); setActive(0) }}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={event => { setTerm(event.target.value); setActive(0); setOpen(true) }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(index => Math.min(index + 1, shown.length - 1)) }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)) }
          else if (event.key === 'Enter' && open) { event.preventDefault(); choose(shown[active]) }
          else if (event.key === 'Escape') { setOpen(false); setTerm('') }
        }}/>
      {value && !disabled && !required
        ? <button type="button" className="icon-button" aria-label={`Limpar ${label}`} onMouseDown={event => event.preventDefault()} onClick={() => onChange('')}><X aria-hidden="true" size={16}/></button>
        : <ChevronDown aria-hidden="true" size={18} className="ui-combobox-caret"/>}
      {name && <input type="hidden" name={name} value={value}/>}
    </div>
    {open && <ul id={id + '-list'} role="listbox" className="ui-combobox-list" aria-label={label}>
      {shown.length ? shown.map((option, index) => <li key={option.value} id={`${id}-opt-${index}`} role="option"
        aria-selected={option.value === value} aria-disabled={option.disabled} data-active={index === active}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(option)}>
        <span>{highlightParts(option.label, term).map((part, key) => part.match ? <mark key={key}>{part.text}</mark> : <span key={key}>{part.text}</span>)}
          {option.hint && <small>{option.hint}</small>}</span>
        {option.value === value && <Check aria-hidden="true" size={16}/>}
      </li>) : <li role="presentation" className="ui-combobox-empty">Nenhuma opção encontrada.</li>}
      {matches.length > limit && <li role="presentation" className="ui-combobox-empty">Mostrando {limit} de {matches.length}. Refine a pesquisa.</li>}
    </ul>}
  </div>
}
