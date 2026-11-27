import { useState } from 'react'
import { BookOpen, Copy, FilePlus2, FileText, Plus, Trash2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Badge, ErrorState, PageHeader } from '../../ui'
import { useIdempotentRpc } from '../../lib/catalog'
import { CatalogLifecycleDialog, Modal, RecordActions, RecordDrawer, useLifecycle } from '../../ui/records'
import { toast } from '../../ui/toast'
import { RecipeEditor, type RecipeSource } from './RecipeEditor'
import { DataTable, type Column } from '../../ui/DataTable'
import { FilterBar, SearchInput, useSessionState } from '../../ui/filters'
import { matchesTerm } from '../../lib/text'

type Ingredient = { id: string; ordinal: number; source_name: string; quantity: number | null; unit: string }
type Version = { id: string; version: number; status: string; yield_min: number | null; yield_target: number | null; yield_max: number | null; recipe_ingredients: Ingredient[] }
export type RecipeRow = { id: string; code: string; name: string; recipe_versions: Version[] }
type Row = { recipe: RecipeRow; version: Version }

const statusLabel = (status: string) => status === 'APROVADA' ? 'Aprovada' : status === 'PENDENTE_VALIDACAO' ? 'Pendente de validação' : status
const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })

type Confirm = { kind: 'version' | 'remove'; row: Row }

/** Confirmação de nova versão e de exclusão de receita em rascunho. Quem decide é o banco. */
function RecipeConfirm({ confirm, onClose, onDone }: { confirm: Confirm | null; onClose: () => void; onDone: (opened?: { id: string; title: string }) => void }) {
  const { run, busy } = useIdempotentRpc()
  const [error, setError] = useState('')
  const [reason, setReason] = useState('')
  const row = confirm?.row
  async function go() {
    if (!confirm || !row) return
    setError('')
    try {
      if (confirm.kind === 'version') {
        const id = await run<string>('create_recipe_version', { source_version: row.version.id }, 'Não foi possível criar a nova versão.')
        const next = Math.max(...row.recipe.recipe_versions.map(version => version.version)) + 1
        toast('Nova versão criada como rascunho pendente.')
        onDone({ id, title: row.recipe.name + ' · versão ' + next })
      } else {
        await run('delete_draft_recipe', { target_version: row.version.id, reason }, 'Não foi possível excluir a receita.')
        toast('Receita excluída.')
        onDone()
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível concluir.') }
  }
  return <Modal open={confirm !== null} title={confirm?.kind === 'version' ? 'Criar nova versão?' : 'Excluir receita definitivamente?'}
    onClose={() => { setError(''); setReason(''); onClose() }}>
    {row && <div className="ui-form">
      <p><span className="ui-code">{row.recipe.code}</span> · {row.recipe.name} · versão {row.version.version}</p>
      {confirm?.kind === 'version'
        ? <p className="ui-muted">A versão aprovada continua intacta e válida para a produção. A nova versão nasce pendente, com os ingredientes e a ficha técnica
          copiados, e só passa a valer depois de uma nova aprovação técnica.</p>
        : <>
          <p className="ui-message">Esta receita nunca foi aprovada nem usada. O banco confere de novo antes de excluir e o registro da exclusão fica na auditoria.</p>
          <label>Justificativa<input value={reason} maxLength={500} onChange={event => setReason(event.target.value)}/></label>
        </>}
      {error && <p className="ui-message" data-tone="danger" role="alert">{error}</p>}
      <div className="ui-modal-actions">
        <button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancelar</button>
        <button type="button" className={confirm?.kind === 'remove' ? 'danger' : undefined} disabled={busy} onClick={() => void go()}>
          {busy ? 'Aguarde…' : confirm?.kind === 'version' ? 'Criar nova versão' : 'Excluir receita'}</button>
      </div>
    </div>}
  </Modal>
}

export function RecipeList({ recipes, loading, error, onRetry, focused, onShowAll, onOpen, canAuthor = false, canRemove = false, startNew = false }: {
  recipes: RecipeRow[] | undefined; loading: boolean; error: boolean; onRetry: () => void
  focused: boolean; onShowAll: () => void; onOpen: (version: { id: string; title: string }) => void
  /** Administração cria receitas, versões e cópias. */ canAuthor?: boolean
  /** Exclusão de rascunho exige também a permissão de aprovação técnica. */ canRemove?: boolean
  startNew?: boolean
}) {
  const cache = useQueryClient()
  const [editor, setEditor] = useState<{ source?: RecipeSource } | null>(startNew && canAuthor ? {} : null)
  const [dirty, setDirty] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const lifecycle = useLifecycle()
  const refresh = () => cache.invalidateQueries({ queryKey: ['recipes'] })
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
      actions={<>
        {focused && <button type="button" className="secondary" onClick={onShowAll}>Ver todas as receitas</button>}
        {canAuthor && <button type="button" onClick={() => { setDirty(false); setEditor({}) }}><Plus aria-hidden="true" size={16}/>Nova receita</button>}
      </>}/>
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
        rowActions={row => {
          if (!canAuthor) return <button type="button" className="secondary" onClick={() => open(row)}>Abrir ficha<span className="sr-only"> {row.recipe.name}</span></button>
          const versions = row.recipe.recipe_versions
          const pendingSibling = versions.some(version => version.status !== 'APROVADA' && version.id !== row.version.id)
          const pending = row.version.status !== 'APROVADA'
          const only = versions.length === 1
          return <RecordActions label={row.recipe.code + ' versão ' + row.version.version} onEdit={() => open(row)} editLabel="Abrir ficha técnica"
            actions={[
              { id: 'version', label: 'Nova versão', icon: FilePlus2, onSelect: () => setConfirm({ kind: 'version', row }), hidden: pending || pendingSibling },
              { id: 'duplicate', label: 'Duplicar receita', icon: Copy, onSelect: () => { setDirty(false); setEditor({ source: {
                versionId: row.version.id, code: row.recipe.code, name: row.recipe.name, version: row.version.version } }) } },
              { id: 'deps', label: 'Dependências', icon: FileText, onSelect: () => lifecycle.open(row.version.id, 'dependencies'), hidden: !canRemove },
              { id: 'history', label: 'Histórico', icon: FileText, onSelect: () => lifecycle.open(row.version.id, 'history'), hidden: !canRemove },
              { id: 'remove', label: only ? 'Excluir receita' : 'Excluir versão', icon: Trash2, danger: true, hidden: !canRemove || !pending,
                onSelect: () => only ? setConfirm({ kind: 'remove', row }) : lifecycle.open(row.version.id, 'delete') },
            ]}/>
        }}/>}
    {canAuthor && <>
      <RecordDrawer open={editor !== null} dirty={dirty} onClose={() => setEditor(null)} title={editor?.source ? 'Duplicar receita' : 'Nova receita'}
        subtitle="A receita nasce pendente de validação.">
        {editor && <RecipeEditor key={editor.source?.versionId ?? 'new'} source={editor.source} onDirty={setDirty}
          onSaved={(id, title) => { setEditor(null); onOpen({ id, title }) }}/>}
      </RecordDrawer>
      <RecipeConfirm confirm={confirm} onClose={() => setConfirm(null)}
        onDone={opened => { setConfirm(null); void refresh(); if (opened) onOpen(opened) }}/>
      <CatalogLifecycleDialog entity="VERSAO_RECEITA" recordId={lifecycle.recordId} mode={lifecycle.mode} onClose={lifecycle.close}
        onModeChange={lifecycle.setMode} onDone={() => { lifecycle.close(); void refresh() }}/>
    </>}
  </section>
}
