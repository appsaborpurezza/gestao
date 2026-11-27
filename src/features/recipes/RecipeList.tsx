import { BookOpen } from 'lucide-react'
import { Badge, ErrorState, PageHeader } from '../../ui'
import { DataTable, type Column } from '../../ui/DataTable'
import { FilterBar, SearchInput, useSessionState } from '../../ui/filters'
import { matchesTerm } from '../../lib/text'

type Ingredient = { id: string; ordinal: number; source_name: string; quantity: number | null; unit: string }
type Version = { id: string; version: number; status: string; yield_min: number | null; yield_target: number | null; yield_max: number | null; recipe_ingredients: Ingredient[] }
export type RecipeRow = { id: string; code: string; name: string; recipe_versions: Version[] }
type Row = { recipe: RecipeRow; version: Version }

const statusLabel = (status: string) => status === 'APROVADA' ? 'Aprovada' : status === 'PENDENTE_VALIDACAO' ? 'Pendente de validação' : status
const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })

export function RecipeList({ recipes, loading, error, onRetry, focused, onShowAll, onOpen }: {
  recipes: RecipeRow[] | undefined; loading: boolean; error: boolean; onRetry: () => void
  focused: boolean; onShowAll: () => void; onOpen: (version: { id: string; title: string }) => void
}) {
  const [filters, setFilters] = useSessionState('recipes', { term: '', status: '' })
  const rows: Row[] = (recipes ?? []).flatMap(recipe => recipe.recipe_versions.map(version => ({ recipe, version })))
  const visible = rows.filter(({ recipe, version }) =>
    matchesTerm(filters.term, recipe.code, recipe.name, ...version.recipe_ingredients.map(item => item.source_name))
    && (!filters.status || version.status === filters.status))
  const open = ({ recipe, version }: Row) => onOpen({ id: version.id, title: recipe.name + ' · versão ' + version.version })
  const columns: Column<Row>[] = [
    { id: 'code', header: 'Código', sortValue: row => row.recipe.code, cell: row => <strong className="ui-code">{row.recipe.code}</strong> },
    { id: 'name', header: 'Receita', sortValue: row => row.recipe.name, cell: row => row.recipe.name },
    { id: 'version', header: 'Versão', align: 'end', sortValue: row => row.version.version, cell: row => row.version.version },
    { id: 'status', header: 'Situação', sortValue: row => row.version.status, cell: row =>
      <Badge tone={row.version.status === 'APROVADA' ? 'success' : 'warning'}>{statusLabel(row.version.status)}</Badge> },
    { id: 'yield', header: 'Rendimento (kg)', optional: true, align: 'end', cell: row => row.version.yield_target === null ? '—'
      : `${number.format(row.version.yield_min ?? 0)} a ${number.format(row.version.yield_max ?? 0)}` },
    { id: 'ingredients', header: 'Ingredientes', align: 'end', sortValue: row => row.version.recipe_ingredients.length, cell: row => <span className="ui-cell-stack">
      <span>{row.version.recipe_ingredients.length}</span>
      {row.version.recipe_ingredients.some(item => item.quantity === null) && <small>Com quantidade a validar</small>}
    </span> },
  ]
  const active = [filters.term, filters.status].filter(Boolean).length

  return <section className="panel">
    <PageHeader icon={BookOpen} title="Receitas" description="Fichas técnicas e versões, com situação de validação."
      actions={focused && <button type="button" className="secondary" onClick={onShowAll}>Ver todas as receitas</button>}/>
    <FilterBar activeCount={active} onClear={() => setFilters({ term: '', status: '' })} onRefresh={onRetry} refreshing={loading}>
      <SearchInput label="Buscar por código, nome ou ingrediente" value={filters.term} onChange={term => setFilters({ ...filters, term })}/>
      <label>Situação <select value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })}>
        <option value="">Todas</option><option value="PENDENTE_VALIDACAO">Pendente de validação</option><option value="APROVADA">Aprovada</option>
      </select></label>
    </FilterBar>
    {error ? <ErrorState title="Falha ao carregar receitas" onRetry={onRetry}/> :
      <DataTable caption="Receitas" rows={recipes ? visible : undefined} columns={columns} loading={loading && !recipes}
        rowKey={row => row.version.id} preferenceKey="recipes" filtered={active > 0}
        onClearFilters={() => setFilters({ term: '', status: '' })}
        empty={{ title: 'Nenhuma receita cadastrada', description: 'Importe as receitas pela tela de importação.' }}
        onRowOpen={open}
        rowActions={row => <button type="button" className="secondary" onClick={() => open(row)}>Abrir ficha<span className="sr-only"> {row.recipe.name}</span></button>}/>}
  </section>
}
