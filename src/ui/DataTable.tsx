import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Columns3, Rows3, SearchX } from 'lucide-react'
import { EmptyState, ErrorState, Skeleton } from './index'

export type Column<Row> = {
  id: string
  header: string
  cell: (row: Row) => ReactNode
  /** Valor usado para ordenar no navegador (modo local). */
  sortValue?: (row: Row) => string | number | null
  align?: 'start' | 'end' | 'center'
  /** Coluna que pode ser ocultada pelo usuário. */
  optional?: boolean
  /** Coluna escondida por padrão. */
  hiddenByDefault?: boolean
  width?: string
}

export type SortState = { column: string; direction: 'asc' | 'desc' } | null

type Props<Row> = {
  caption: string
  rows: Row[] | undefined
  columns: Column<Row>[]
  rowKey: (row: Row) => string
  loading?: boolean
  error?: boolean
  onRetry?: () => void
  /** Total de registros no servidor; ausente quando a paginação é local. */
  total?: number
  page?: number
  pageSize?: number
  onPageChange?: (page: number) => void
  onPageSizeChange?: (size: number) => void
  sort?: SortState
  onSortChange?: (sort: SortState) => void
  filtered?: boolean
  onClearFilters?: () => void
  empty?: { title: string; description?: ReactNode; action?: ReactNode }
  rowActions?: (row: Row) => ReactNode
  onRowOpen?: (row: Row) => void
  /** Chave para lembrar colunas e densidade do usuário. */
  preferenceKey?: string
  toolbar?: ReactNode
  /** Seleção múltipla (ações em massa). As chaves são as de rowKey. */
  selection?: { selected: Set<string>; onChange: (next: Set<string>) => void; rowLabel?: (row: Row) => string }
}

const pageSizes = [10, 25, 50, 100]
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' })

function readPreference<T>(key: string | undefined, fallback: T): T {
  if (!key) return fallback
  try { return { ...fallback, ...JSON.parse(localStorage.getItem('purezza:table:' + key) ?? '{}') } } catch { return fallback }
}

export function DataTable<Row>(props: Props<Row>) {
  const { caption, rows, columns, rowKey, loading, error, onRetry, filtered, onClearFilters, empty, rowActions, onRowOpen, preferenceKey } = props
  const serverMode = props.total !== undefined
  const [prefs, setPrefs] = useState(() => readPreference(preferenceKey, {
    density: 'comfortable' as 'comfortable' | 'compact',
    hidden: columns.filter(column => column.hiddenByDefault).map(column => column.id),
  }))
  const [localSort, setLocalSort] = useState<SortState>(null)
  const [localPage, setLocalPage] = useState(0)
  const [localSize, setLocalSize] = useState(25)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const columnsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (preferenceKey) localStorage.setItem('purezza:table:' + preferenceKey, JSON.stringify(prefs))
  }, [preferenceKey, prefs])
  useEffect(() => {
    if (!columnsOpen) return
    const close = (event: MouseEvent) => { if (!columnsRef.current?.contains(event.target as Node)) setColumnsOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [columnsOpen])

  const sort = props.onSortChange ? props.sort ?? null : localSort
  const setSort = props.onSortChange ?? setLocalSort
  const page = serverMode ? props.page ?? 0 : localPage
  const pageSize = serverMode ? props.pageSize ?? 25 : localSize
  const setPage = serverMode ? props.onPageChange ?? (() => {}) : setLocalPage
  const setPageSize = serverMode ? props.onPageSizeChange : (size: number) => { setLocalSize(size); setLocalPage(0) }

  const visible = columns.filter(column => !prefs.hidden.includes(column.id))
  const selection = props.selection

  const sorted = useMemo(() => {
    if (!rows || serverMode || !sort) return rows
    const column = columns.find(item => item.id === sort.column)
    if (!column?.sortValue) return rows
    const factor = sort.direction === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const left = column.sortValue!(a), right = column.sortValue!(b)
      if (left == null) return 1
      if (right == null) return -1
      return factor * (typeof left === 'number' && typeof right === 'number' ? left - right : collator.compare(String(left), String(right)))
    })
  }, [rows, serverMode, sort, columns])

  const total = serverMode ? props.total! : sorted?.length ?? 0
  const pageRows = serverMode ? sorted : sorted?.slice(page * pageSize, page * pageSize + pageSize)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  useEffect(() => { if (!serverMode && localPage > 0 && localPage >= pages) setLocalPage(pages - 1) }, [serverMode, localPage, pages])

  const toggleSort = (column: Column<Row>) => {
    if (!column.sortValue) return
    if (sort?.column !== column.id) setSort({ column: column.id, direction: 'asc' })
    else if (sort.direction === 'asc') setSort({ column: column.id, direction: 'desc' })
    else setSort(null)
    if (!serverMode) setLocalPage(0)
  }

  const optional = columns.filter(column => column.optional)
  const from = total ? page * pageSize + 1 : 0
  const to = Math.min(total, (page + 1) * pageSize)

  return <section className="ui-table" data-density={prefs.density} aria-label={caption}>
    <div className="ui-table-toolbar">
      <div className="ui-table-toolbar-main">{props.toolbar}</div>
      <div className="ui-table-toolbar-tools">
        <span className="ui-table-count" role="status">{loading ? 'Carregando…' : `${total.toLocaleString('pt-BR')} ${total === 1 ? 'registro' : 'registros'}`}</span>
        <button type="button" className="icon-button" aria-pressed={prefs.density === 'compact'}
          title={prefs.density === 'compact' ? 'Densidade confortável' : 'Densidade compacta'}
          aria-label={prefs.density === 'compact' ? 'Usar densidade confortável' : 'Usar densidade compacta'}
          onClick={() => setPrefs(value => ({ ...value, density: value.density === 'compact' ? 'comfortable' : 'compact' }))}>
          <Rows3 aria-hidden="true" size={18}/>
        </button>
        {optional.length > 0 && <div className="ui-popover-anchor" ref={columnsRef}>
          <button type="button" className="icon-button" aria-haspopup="true" aria-expanded={columnsOpen}
            aria-label="Escolher colunas" title="Escolher colunas" onClick={() => setColumnsOpen(value => !value)}>
            <Columns3 aria-hidden="true" size={18}/>
          </button>
          {columnsOpen && <fieldset className="ui-popover">
            <legend>Colunas visíveis</legend>
            {optional.map(column => <label key={column.id} className="ui-check">
              <input type="checkbox" checked={!prefs.hidden.includes(column.id)} onChange={event => setPrefs(value => ({
                ...value, hidden: event.target.checked ? value.hidden.filter(id => id !== column.id) : [...value.hidden, column.id],
              }))}/>{column.header}
            </label>)}
          </fieldset>}
        </div>}
      </div>
    </div>

    {error ? <ErrorState onRetry={onRetry}/> : loading && !rows ? <Skeleton lines={6} label="Carregando registros…"/> :
      !pageRows?.length ? (filtered
        ? <EmptyState icon={SearchX} title="Nenhum resultado para os filtros" description="Revise a pesquisa ou limpe os filtros aplicados."
          action={onClearFilters && <button type="button" className="secondary" onClick={onClearFilters}>Limpar filtros</button>}/>
        : <EmptyState title={empty?.title ?? 'Nenhum registro'} description={empty?.description} action={empty?.action}/>) :
      <div className="ui-table-scroll" tabIndex={0} aria-label={caption + ' (role para ver todas as colunas)'}>
        <table>
          <caption className="sr-only">{caption}</caption>
          <thead><tr>
            {selection && (() => {
              const keys = pageRows.map(rowKey)
              const all = keys.length > 0 && keys.every(key => selection.selected.has(key))
              const some = keys.some(key => selection.selected.has(key))
              return <th scope="col" className="ui-select-cell">
                <input type="checkbox" aria-label="Selecionar todos desta página" checked={all}
                  ref={element => { if (element) element.indeterminate = some && !all }}
                  onChange={() => {
                    const next = new Set(selection.selected)
                    keys.forEach(key => { if (all) next.delete(key); else next.add(key) })
                    selection.onChange(next)
                  }}/>
              </th>
            })()}
            {visible.map(column => {
              const sortable = !!column.sortValue
              const active = sort?.column === column.id
              return <th key={column.id} scope="col" data-align={column.align} style={column.width ? { width: column.width } : undefined}
                aria-sort={active ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
                {sortable ? <button type="button" className="ui-sort" onClick={() => toggleSort(column)}>
                  {column.header}
                  {active ? (sort!.direction === 'asc' ? <ArrowUp aria-hidden="true" size={14}/> : <ArrowDown aria-hidden="true" size={14}/>)
                    : <ArrowUpDown aria-hidden="true" size={14} className="ui-sort-idle"/>}
                </button> : column.header}
              </th>
            })}
            {rowActions && <th scope="col" data-align="end"><span className="sr-only">Ações</span></th>}
          </tr></thead>
          <tbody>
            {pageRows.map(row => <tr key={rowKey(row)} data-clickable={!!onRowOpen || undefined}
              onClick={onRowOpen ? event => { if (!(event.target as HTMLElement).closest('button,a,input,select,label')) onRowOpen(row) } : undefined}>
              {selection && <td className="ui-select-cell"><input type="checkbox" checked={selection.selected.has(rowKey(row))}
                aria-label={'Selecionar ' + (selection.rowLabel?.(row) ?? 'registro')}
                onChange={event => {
                  const next = new Set(selection.selected)
                  if (event.target.checked) next.add(rowKey(row)); else next.delete(rowKey(row))
                  selection.onChange(next)
                }}/></td>}
              {visible.map(column => <td key={column.id} data-align={column.align} data-label={column.header}>{column.cell(row)}</td>)}
              {rowActions && <td data-align="end" className="ui-row-actions">{rowActions(row)}</td>}
            </tr>)}
          </tbody>
        </table>
      </div>}

    {total > 0 && <nav className="ui-pagination" aria-label="Paginação">
      <span>{from.toLocaleString('pt-BR')}–{to.toLocaleString('pt-BR')} de {total.toLocaleString('pt-BR')}</span>
      {setPageSize && <label>Por página
        <select value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>
          {pageSizes.map(size => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>}
      <button type="button" className="icon-button" aria-label="Página anterior" disabled={page === 0} onClick={() => setPage(page - 1)}>
        <ChevronLeft aria-hidden="true" size={18}/>
      </button>
      <span aria-live="polite">Página {page + 1} de {pages}</span>
      <button type="button" className="icon-button" aria-label="Próxima página" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
        <ChevronRight aria-hidden="true" size={18}/>
      </button>
    </nav>}
  </section>
}
