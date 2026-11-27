import { useMemo, useState, type FormEvent } from 'react'
import { Copy, Plus, Settings2, Tags } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useIdempotentRpc } from '../../lib/catalog'
import { CatalogLifecycleDialog, RecordActions, RecordDrawer, SimilarRecords, lifecycleActions, useLifecycle } from '../../ui/records'
import { toast } from '../../ui/toast'
import { DataTable, type Column } from '../../ui/DataTable'
import { FilterBar, SearchInput, useDebouncedValue, useSessionState } from '../../ui/filters'
import { Badge, PageHeader } from '../../ui'
import { highlightParts, matchesTerm } from '../../lib/text'

export type CatalogItem = {
  id: string; original_code: string; original_description: string; commercial_description: string | null
  classification: string; validation_status: string; base_unit: string | null; unit_version: number
  active?: boolean; catalog_version?: number
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

const productClasses = ['FABRICACAO_PROPRIA', 'TERCEIRO', 'REVENDA_A_VALIDAR', 'FARINHA_USO_REVENDA_A_VALIDAR']
type Editor = { mode: 'new' | 'edit' | 'duplicate'; item?: CatalogItem }

/** Inclusão, edição e duplicação de produto. Código e descrição original não mudam depois de gravados. */
function ProductForm({ editor, onDirty, onSaved }: { editor: Editor; onDirty: (dirty: boolean) => void; onSaved: () => void }) {
  const { run, busy } = useIdempotentRpc()
  const [error, setError] = useState('')
  const editing = editor.mode === 'edit' ? editor.item : undefined
  const source = editor.item
  const [description, setDescription] = useState(editor.mode === 'duplicate' ? source?.original_description ?? '' : '')

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const input = Object.fromEntries(['code', 'description', 'commercial_description', 'classification', 'unit']
      .map(key => [key, String(form.get(key) ?? '').trim() || null]))
    setError('')
    try {
      await run('save_item', { target: editing?.id ?? null, expected_version: editing?.catalog_version ?? null, input },
        'Não foi possível salvar o produto.')
      toast(editing ? 'Produto atualizado.' : 'Produto incluído.')
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar o produto.')
    }
  }

  return <form className="ui-form" onSubmit={save} onChange={() => onDirty(true)}>
    {editor.mode === 'duplicate' && <p className="ui-message">Cópia de <span className="ui-code">{source?.original_code}</span>.
      Informe um código novo. Receitas, embalagens e estoque não são copiados.</p>}
    <fieldset className="ui-fieldset">
      <legend>Identificação</legend>
      {editing ? <p className="ui-muted">Código <span className="ui-code">{editing.original_code}</span> · {editing.original_description}</p> : <>
        <label><span>Código <span className="ui-required" aria-hidden="true">*</span></span>
          <input name="code" required maxLength={60} autoComplete="off"/></label>
        <label><span>Descrição original <span className="ui-required" aria-hidden="true">*</span></span>
          <input name="description" required maxLength={180} value={description} onChange={event => setDescription(event.target.value)}/></label>
        <SimilarRecords entity="PRODUTO" term={editor.mode === 'duplicate' && description === source?.original_description ? '' : description}/>
      </>}
      <label>Descrição comercial
        <input name="commercial_description" maxLength={180} defaultValue={source?.commercial_description ?? ''}/></label>
      <label><span>Classificação <span className="ui-required" aria-hidden="true">*</span></span>
        <select name="classification" required defaultValue={source?.classification && productClasses.includes(source.classification) ? source.classification : ''}>
          <option value="">Selecione</option>
          {productClasses.map(value => <option key={value} value={value}>{classificationLabels[value]}</option>)}
        </select></label>
      {!editing && <label>Unidade base
        <select name="unit" defaultValue={source?.base_unit ?? ''}><option value="">A validar</option>
          {['kg', 'g', 'un', 'L', 'mL'].map(unit => <option key={unit}>{unit}</option>)}</select></label>}
      {editing && <p className="ui-muted">A unidade base e as embalagens são configuradas em “Unidade”. Classificação não muda se o produto já tiver pedidos, lotes, demandas, receitas ou embalagens.</p>}
    </fieldset>
    {error && <p className="ui-message" data-tone="danger" role="alert">{error}</p>}
    <div className="ui-modal-actions"><button disabled={busy}>{busy ? 'Salvando…' : editing ? 'Salvar alterações' : 'Incluir produto'}</button></div>
  </form>
}

/**
 * Catálogo de produtos. O catálogo é pequeno (dezenas de itens) e já é consultado com colunas selecionadas,
 * então filtros e ordenação rodam no navegador. Tabelas volumosas usam o modo servidor do DataTable.
 */
export function ProductCatalog({ items, loading, error, onRetry, canConfigure, onConfigure, focused, onShowAll, startNew = false }: {
  items: CatalogItem[] | undefined; loading: boolean; error: boolean; onRetry: () => void
  canConfigure: boolean; onConfigure: (id: string) => void; focused: boolean; onShowAll: () => void; startNew?: boolean
}) {
  const cache = useQueryClient()
  const [filters, setFilters] = useSessionState('products', { term: '', classification: '', unit: '', status: '' })
  const term = useDebouncedValue(filters.term)
  const active = [filters.term, filters.classification, filters.unit, filters.status].filter(Boolean).length
  const [editor, setEditor] = useState<Editor | null>(startNew && canConfigure ? { mode: 'new' } : null)
  const [dirty, setDirty] = useState(false)
  const lifecycle = useLifecycle()
  const lifecycleItem = items?.find(item => item.id === lifecycle.recordId)
  const openEditor = (next: Editor) => { setDirty(false); setEditor(next) }
  const refresh = () => Promise.all(['items', 'catalog-similar', 'orders', 'inventory'].map(key => cache.invalidateQueries({ queryKey: [key] })))
  const clear = () => setFilters({ term: '', classification: '', unit: '', status: '' })

  const rows = useMemo(() => items?.filter(item =>
    matchesTerm(term, item.original_code, item.original_description, item.commercial_description)
    && (!filters.classification || item.classification === filters.classification)
    && (!filters.unit || (filters.unit === 'none' ? !item.base_unit : item.base_unit === filters.unit))
    && (!filters.status || (filters.status === 'active') === (item.active !== false))
  ), [items, term, filters.classification, filters.unit, filters.status])

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
    { id: 'active', header: 'Situação', optional: true, sortValue: row => row.active === false ? 1 : 0,
      cell: row => <Badge tone={row.active === false ? 'neutral' : 'success'}>{row.active === false ? 'Inativo' : 'Ativo'}</Badge> },
  ]

  return <>
    <PageHeader icon={Tags} title="Produtos" description="Catálogo com os códigos e descrições originais preservados."
      actions={<>
        {focused && <button type="button" className="secondary" onClick={onShowAll}>Ver todos os produtos</button>}
        {canConfigure && <button type="button" onClick={() => openEditor({ mode: 'new' })}><Plus aria-hidden="true" size={16}/>Novo produto</button>}
      </>}/>
    <FilterBar activeCount={active} onClear={clear} onRefresh={onRetry} refreshing={loading}>
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
      <select aria-label="Situação" value={filters.status} onChange={event => setFilters(current => ({ ...current, status: event.target.value }))}>
        <option value="">Ativos e inativos</option><option value="active">Somente ativos</option><option value="inactive">Somente inativos</option>
      </select>
    </FilterBar>
    <DataTable caption="Produtos" rows={rows} columns={columns} rowKey={row => row.id} loading={loading} error={error} onRetry={onRetry}
      preferenceKey="products" filtered={active > 0} onClearFilters={clear}
      empty={{ title: 'Nenhum produto cadastrado', description: 'Importe o catálogo em Administração › Importação ou use “Novo produto”.' }}
      rowActions={canConfigure ? row => {
        const insumo = row.classification === 'INSUMO'
        return <RecordActions label={row.original_code} onEdit={insumo ? undefined : () => openEditor({ mode: 'edit', item: row })}
          actions={[
            { id: 'unit', label: 'Unidade e embalagens', icon: Settings2, onSelect: () => onConfigure(row.id) },
            { id: 'duplicate', label: 'Duplicar', icon: Copy, onSelect: () => openEditor({ mode: 'duplicate', item: row }), hidden: insumo },
            ...lifecycleActions(row.active ?? null, mode => lifecycle.open(row.id, mode)),
          ]}/>
      } : undefined}/>
    {canConfigure && <>
      <RecordDrawer open={editor !== null} dirty={dirty} onClose={() => setEditor(null)}
        title={editor?.mode === 'edit' ? 'Editar produto' : editor?.mode === 'duplicate' ? 'Duplicar produto' : 'Novo produto'}>
        {editor && <ProductForm key={editor.mode + (editor.item?.id ?? '')} editor={editor} onDirty={setDirty}
          onSaved={() => { setEditor(null); void refresh() }}/>}
      </RecordDrawer>
      {/* Insumos usam a entidade INSUMO; as demais classificações, PRODUTO. O banco confere de novo. */}
      <CatalogLifecycleDialog entity={lifecycleItem?.classification === 'INSUMO' ? 'INSUMO' : 'PRODUTO'}
        recordId={lifecycle.recordId} mode={lifecycle.mode} onClose={lifecycle.close} onModeChange={lifecycle.setMode}
        onDone={() => { lifecycle.close(); void refresh() }}/>
    </>}
  </>
}
