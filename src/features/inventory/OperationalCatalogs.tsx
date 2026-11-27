import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Factory, Plus } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useIdempotentRpc, type CatalogEntity } from '../../lib/catalog'
import { Badge, PageHeader } from '../../ui'
import { DataTable, type Column } from '../../ui/DataTable'
import { Tabs } from '../../ui/Tabs'
import { FilterBar, SearchInput, useDebouncedValue } from '../../ui/filters'
import { CatalogLifecycleDialog, RecordActions, RecordDrawer, SimilarRecords, lifecycleActions, useLifecycle } from '../../ui/records'
import { toast } from '../../ui/toast'

const catalogs = {
  FORNECEDOR: { title: 'Fornecedores', singular: 'fornecedor', table: 'suppliers', label: 'Nome do fornecedor' },
  FABRICANTE: { title: 'Fabricantes', singular: 'fabricante', table: 'manufacturers', label: 'Nome do fabricante' },
  LOCAL: { title: 'Locais de estoque', singular: 'local de estoque', table: 'locations', label: 'Código do local' },
  INSUMO: { title: 'Insumos', singular: 'insumo', table: 'items', label: 'Descrição do insumo' },
} as const
type Catalog = keyof typeof catalogs & CatalogEntity
type Row = { id: string; label: string; active: boolean; version: number; code?: string; unit?: string | null }
type Status = 'TODOS' | 'ATIVOS' | 'INATIVOS'
const units = ['kg', 'g', 'un', 'L', 'mL']

/** Remove caracteres que alteram a sintaxe do filtro do PostgREST. */
const safeTerm = (value: string) => value.replace(/[,()%*\\]/g, ' ').trim()

function invalidateCatalogs(cache: ReturnType<typeof useQueryClient>) {
  return Promise.all(['operational-catalog', 'items', 'inventory', 'shipping', 'orders', 'catalog-similar']
    .map(key => cache.invalidateQueries({ queryKey: [key] })))
}

function CatalogForm({ catalog, entry, onDirty, onSaved }: {
  catalog: Catalog; entry: Row | null; onDirty: (dirty: boolean) => void; onSaved: () => void
}) {
  const cache = useQueryClient()
  const { run, busy } = useIdempotentRpc()
  const [error, setError] = useState('')
  const [label, setLabel] = useState(entry?.label ?? '')

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    // A situação muda pelo menu (Inativar/Reativar), que exige motivo e confere vínculos.
    const input = { label: String(data.get('label') ?? '').trim(), code: data.get('code'), unit: data.get('unit'), active: entry?.active ?? true }
    setError('')
    try {
      await run('save_operational_catalog', {
        catalog, target: entry?.id ?? null, expected_version: entry?.version ?? null, input,
      }, 'Falha ao salvar o cadastro.')
      await invalidateCatalogs(cache)
      toast(entry ? 'Cadastro atualizado.' : 'Cadastro incluído.')
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao salvar o cadastro.')
    }
  }

  return <form className="ui-form" onSubmit={save} onChange={() => onDirty(true)}>
    {catalog === 'INSUMO' && entry && <p className="ui-muted">Código <span className="ui-code">{entry.code}</span> · Unidade {entry.unit ?? 'A validar'}</p>}
    <fieldset className="ui-fieldset">
      <legend>Dados do cadastro</legend>
      {catalog === 'INSUMO' && !entry && <label><span>Código interno <span className="ui-required" aria-hidden="true">*</span></span>
        <input name="code" maxLength={60} required autoComplete="off"/></label>}
      <label><span>{catalogs[catalog].label} <span className="ui-required" aria-hidden="true">*</span></span>
        <input name="label" maxLength={catalog === 'LOCAL' ? 60 : 180} value={label} required autoComplete="off"
          onChange={event => setLabel(event.target.value)}/>
      </label>
      <SimilarRecords entity={catalog} term={label === entry?.label ? '' : label} excludeId={entry?.id}/>
      {catalog === 'INSUMO' && !entry && <label><span>Unidade base <span className="ui-required" aria-hidden="true">*</span></span>
        <select name="unit" required><option value="">Selecione</option>
          {units.map(unit => <option key={unit}>{unit}</option>)}
        </select>
      </label>}
      {entry && <p className="ui-muted">Situação: <Badge tone={entry.active ? 'success' : 'neutral'}>{entry.active ? 'Ativo' : 'Inativo'}</Badge>.
        Para alterar, use Inativar ou Reativar no menu do registro.</p>}
    </fieldset>
    {error && <p className="ui-message" data-tone="danger" role="alert">{error}</p>}
    <div className="ui-modal-actions">
      <button disabled={busy}>{busy ? 'Salvando…' : entry ? 'Salvar alterações' : 'Incluir cadastro'}</button>
    </div>
  </form>
}

export function OperationalCatalogs({ startNew = false }: { startNew?: boolean } = {}) {
  const cache = useQueryClient()
  const [catalog, setCatalog] = useState<Catalog>('FORNECEDOR')
  const [editor, setEditor] = useState<Row | null | undefined>(startNew ? null : undefined)
  const [dirty, setDirty] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<Status>('TODOS')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const lifecycle = useLifecycle()
  const term = safeTerm(useDebouncedValue(search, 300))
  const from = page * pageSize
  const to = from + pageSize - 1
  const list = useQuery({
    queryKey: ['operational-catalog', catalog, page, pageSize, term, status],
    placeholderData: previous => previous,
    queryFn: async (): Promise<{ rows: Row[]; count: number }> => {
      const pattern = '%' + term + '%'
      if (catalog === 'INSUMO') {
        let request = supabase.from('items')
          .select('id,original_code,original_description,commercial_description,active,catalog_version,base_unit', { count: 'exact' })
          .eq('classification', 'INSUMO')
        if (term) request = request.or(`original_code.ilike.${pattern},original_description.ilike.${pattern},commercial_description.ilike.${pattern}`)
        if (status !== 'TODOS') request = request.eq('active', status === 'ATIVOS')
        const { data, count, error } = await request.order('original_code').range(from, to)
        if (error) throw error
        return { count: count ?? 0, rows: data.map(row => ({
          id: row.id, label: row.commercial_description ?? row.original_description, active: row.active,
          version: row.catalog_version, code: row.original_code, unit: row.base_unit,
        })) }
      }
      if (catalog === 'LOCAL') {
        let request = supabase.from('locations').select('id,code,active,version', { count: 'exact' })
        if (term) request = request.ilike('code', pattern)
        if (status !== 'TODOS') request = request.eq('active', status === 'ATIVOS')
        const { data, count, error } = await request.order('code').range(from, to)
        if (error) throw error
        return { count: count ?? 0, rows: data.map(row => ({ ...row, label: row.code })) }
      }
      let request = supabase.from(catalogs[catalog].table).select('id,name,active,version', { count: 'exact' })
      if (term) request = request.ilike('name', pattern)
      if (status !== 'TODOS') request = request.eq('active', status === 'ATIVOS')
      const { data, count, error } = await request.order('name').order('id').range(from, to)
      if (error) throw error
      return { count: count ?? 0, rows: data.map(row => ({ ...row, label: row.name })) }
    },
  })
  const stale = list.isPlaceholderData
  const filters = (term ? 1 : 0) + (status !== 'TODOS' ? 1 : 0)
  const openEditor = (row: Row | null) => { setDirty(false); setEditor(row) }
  const columns: Column<Row>[] = [
    ...(catalog === 'INSUMO' ? [{ id: 'code', header: 'Código', cell: (row: Row) => <span className="ui-code">{row.code}</span> }] : []),
    { id: 'label', header: catalogs[catalog].label, cell: row => <strong>{row.label}</strong> },
    ...(catalog === 'INSUMO' ? [{ id: 'unit', header: 'Unidade', cell: (row: Row) => row.unit ?? <Badge tone="warning">A validar</Badge> }] : []),
    { id: 'status', header: 'Situação', cell: row => <Badge tone={row.active ? 'success' : 'neutral'}>{row.active ? 'Ativo' : 'Inativo'}</Badge> },
  ]

  return <section className="panel">
    <PageHeader icon={Factory} title="Cadastros operacionais"
      description="Fornecedores, fabricantes, locais de estoque e insumos usados no recebimento e na produção."
      actions={<button type="button" onClick={() => openEditor(null)}><Plus aria-hidden="true" size={16}/>Novo {catalogs[catalog].singular}</button>}/>
    <Tabs label="Tipos de cadastro" value={catalog} onChange={key => { setCatalog(key); setPage(0); setEditor(undefined); setSearch('') }}
      items={(Object.keys(catalogs) as Catalog[]).map(key => ({ id: key, label: catalogs[key].title }))}/>
    <FilterBar activeCount={filters} onClear={() => { setSearch(''); setStatus('TODOS'); setPage(0) }}
      onRefresh={() => void list.refetch()} refreshing={list.isFetching}>
      <SearchInput label={'Pesquisar ' + catalogs[catalog].title.toLowerCase()} value={search} onChange={value => { setSearch(value); setPage(0) }}/>
      <label>Situação
        <select value={status} onChange={event => { setStatus(event.target.value as Status); setPage(0) }}>
          <option value="TODOS">Todos</option><option value="ATIVOS">Ativos</option><option value="INATIVOS">Inativos</option>
        </select>
      </label>
    </FilterBar>
    <DataTable caption={catalogs[catalog].title} rows={stale ? undefined : list.data?.rows} columns={columns} rowKey={row => row.id}
      loading={list.isFetching} error={list.isError} onRetry={() => void list.refetch()}
      total={list.data?.count ?? 0} page={page} pageSize={pageSize} onPageChange={setPage}
      onPageSizeChange={size => { setPageSize(size); setPage(0) }}
      filtered={filters > 0} onClearFilters={() => { setSearch(''); setStatus('TODOS'); setPage(0) }}
      empty={{ title: 'Nenhum cadastro', description: 'Use “Novo ' + catalogs[catalog].singular + '” para incluir o primeiro registro deste tipo.' }}
      onRowOpen={row => openEditor(row)}
      rowActions={row => <RecordActions label={row.label} onEdit={() => openEditor(row)}
        actions={lifecycleActions(row.active, mode => lifecycle.open(row.id, mode))}/>}/>
    <RecordDrawer open={editor !== undefined} dirty={dirty} onClose={() => setEditor(undefined)}
      title={editor ? 'Editar ' + catalogs[catalog].singular : 'Novo ' + catalogs[catalog].singular}>
      {editor !== undefined && <CatalogForm key={catalog + (editor?.id ?? 'new')} catalog={catalog} entry={editor}
        onDirty={setDirty} onSaved={() => setEditor(undefined)}/>}
    </RecordDrawer>
    <CatalogLifecycleDialog entity={catalog} recordId={lifecycle.recordId} mode={lifecycle.mode}
      onClose={lifecycle.close} onModeChange={lifecycle.setMode}
      onDone={() => { lifecycle.close(); void invalidateCatalogs(cache) }}/>
  </section>
}
