import { useMemo } from 'react'
import { Settings2, Tags } from 'lucide-react'
import { DataTable, type Column } from '../../ui/DataTable'
import { FilterBar, SearchInput, useDebouncedValue, useSessionState } from '../../ui/filters'
import { Badge, PageHeader } from '../../ui'
import { highlightParts, matchesTerm } from '../../lib/text'

export type CatalogItem = {
  id: string; original_code: string; original_description: string; commercial_description: string | null
  classification: string; validation_status: string; base_unit: string | null; unit_version: number
}

const classificationLabels: Record<string, string> = {
  FABRICACAO_PROPRIA: 'Fabricação própria', TERCEIRO: 'Terceiro', REVENDA_A_VALIDAR: 'Revenda a validar',
  FARINHA_USO_REVENDA_A_VALIDAR: 'Farinha uso/revenda', INSUMO: 'Insumo',
}
const validationLabels: Record<string, string> = { PENDENTE_VALIDACAO: 'Pendente de validação', VALIDADO: 'Validado' }
const validationTone = (status: string) => status === 'VALIDADO' ? 'success' : status.startsWith('PENDENTE') ? 'warning' : 'neutral'
const label = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replaceAll('_', ' ')

function Highlight({ text, term }: { text: string; term: string }) {
  return <>{highlightParts(text, term).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</>
}

/**
 * Catálogo de produtos. O catálogo é pequeno (dezenas de itens) e já é consultado com colunas selecionadas,
 * então filtros e ordenação rodam no navegador. Tabelas volumosas usam o modo servidor do DataTable.
 */
export function ProductCatalog({ items, loading, error, onRetry, canConfigure, onConfigure, focused, onShowAll }: {
  items: CatalogItem[] | undefined; loading: boolean; error: boolean; onRetry: () => void
  canConfigure: boolean; onConfigure: (id: string) => void; focused: boolean; onShowAll: () => void
}) {
  const [filters, setFilters] = useSessionState('products', { term: '', classification: '', unit: '' })
  const term = useDebouncedValue(filters.term)
  const active = [filters.term, filters.classification, filters.unit].filter(Boolean).length

  const rows = useMemo(() => items?.filter(item =>
    matchesTerm(term, item.original_code, item.original_description, item.commercial_description)
    && (!filters.classification || item.classification === filters.classification)
    && (!filters.unit || (filters.unit === 'none' ? !item.base_unit : item.base_unit === filters.unit))
  ), [items, term, filters.classification, filters.unit])

  const classifications = useMemo(() => [...new Set(items?.map(item => item.classification))].sort(), [items])

  const columns: Column<CatalogItem>[] = [
    { id: 'code', header: 'Código', width: '9rem', sortValue: row => row.original_code,
      cell: row => <code className="ui-code"><Highlight text={row.original_code} term={term}/></code> },
    { id: 'description', header: 'Produto', sortValue: row => row.commercial_description ?? row.original_description,
      cell: row => <div className="ui-cell-stack">
        <strong><Highlight text={row.commercial_description ?? row.original_description} term={term}/></strong>
        {row.commercial_description && <small>Original: {row.original_description}</small>}
      </div> },
    { id: 'classification', header: 'Classificação', optional: true, sortValue: row => classificationLabels[row.classification] ?? row.classification,
      cell: row => <Badge tone={row.classification === 'FABRICACAO_PROPRIA' ? 'info' : 'neutral'}>{classificationLabels[row.classification] ?? label(row.classification)}</Badge> },
    { id: 'validation', header: 'Validação', optional: true, sortValue: row => row.validation_status,
      cell: row => <Badge tone={validationTone(row.validation_status)}>{validationLabels[row.validation_status] ?? label(row.validation_status)}</Badge> },
    { id: 'unit', header: 'Unidade', align: 'center', width: '7rem', sortValue: row => row.base_unit ?? '',
      cell: row => row.base_unit ?? <Badge tone="warning">A validar</Badge> },
  ]

  return <>
    <PageHeader icon={Tags} title="Produtos" description="Catálogo com os códigos e descrições originais preservados."
      actions={focused && <button type="button" className="secondary" onClick={onShowAll}>Ver todos os produtos</button>}/>
    <FilterBar activeCount={active} onClear={() => setFilters({ term: '', classification: '', unit: '' })} onRefresh={onRetry} refreshing={loading}>
      <SearchInput label="Pesquisar por código ou descrição" value={filters.term} onChange={value => setFilters(current => ({ ...current, term: value }))}/>
      <select aria-label="Classificação" value={filters.classification} onChange={event => setFilters(current => ({ ...current, classification: event.target.value }))}>
        <option value="">Todas as classificações</option>
        {classifications.map(value => <option key={value} value={value}>{classificationLabels[value] ?? label(value)}</option>)}
      </select>
      <select aria-label="Unidade" value={filters.unit} onChange={event => setFilters(current => ({ ...current, unit: event.target.value }))}>
        <option value="">Todas as unidades</option>
        {['kg', 'g', 'un', 'L', 'mL'].map(unit => <option key={unit} value={unit}>{unit}</option>)}
        <option value="none">Unidade a validar</option>
      </select>
    </FilterBar>
    <DataTable caption="Produtos" rows={rows} columns={columns} rowKey={row => row.id} loading={loading} error={error} onRetry={onRetry}
      preferenceKey="products" filtered={active > 0} onClearFilters={() => setFilters({ term: '', classification: '', unit: '' })}
      empty={{ title: 'Nenhum produto cadastrado', description: 'Importe o catálogo em Administração › Importação.' }}
      rowActions={canConfigure ? row => <button type="button" className="secondary" onClick={() => onConfigure(row.id)}>
        <Settings2 aria-hidden="true" size={16}/>Unidade<span className="sr-only"> do item {row.original_code}</span>
      </button> : undefined}/>
  </>
}
