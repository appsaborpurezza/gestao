import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Factory, Plus, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { Badge, PageHeader } from '../../ui'
import { DataTable, type Column } from '../../ui/DataTable'
import { Tabs } from '../../ui/Tabs'

const catalogs = {
  FORNECEDOR: { title: 'Fornecedores', singular: 'fornecedor', table: 'suppliers', label: 'Nome do fornecedor' },
  FABRICANTE: { title: 'Fabricantes', singular: 'fabricante', table: 'manufacturers', label: 'Nome do fabricante' },
  LOCAL: { title: 'Locais de estoque', singular: 'local de estoque', table: 'locations', label: 'Código do local' },
  INSUMO: { title: 'Insumos', singular: 'insumo', table: 'items', label: 'Descrição do insumo' },
} as const
type Catalog = keyof typeof catalogs
type Row = { id: string; label: string; active: boolean; version: number; code?: string; unit?: string | null }
const units = ['kg', 'g', 'un', 'L', 'mL']

function CatalogForm({ catalog, entry, onClose }: { catalog: Catalog; entry: Row | null; onClose: () => void }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const pending = useRef<{ payload: string; id: string } | null>(null)

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const data = new FormData(event.currentTarget)
    const input = { label: data.get('label'), code: data.get('code'), unit: data.get('unit'), active: data.has('active') }
    const payload = JSON.stringify(input)
    if (pending.current?.payload !== payload) pending.current = { payload, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error } = await supabase.rpc('save_operational_catalog', {
        catalog, target: entry?.id ?? null, expected_version: entry?.version ?? null,
        input, request_id: pending.current.id,
      })
      if (error) throw new Error(error.code === '23505' ? 'Já existe um cadastro com este nome ou código.' : error.message)
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['operational-catalog'] }),
        cache.invalidateQueries({ queryKey: ['items'] }),
        cache.invalidateQueries({ queryKey: ['inventory'] }),
        cache.invalidateQueries({ queryKey: ['shipping'] }),
        cache.invalidateQueries({ queryKey: ['orders'] }),
      ])
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao salvar o cadastro.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const title = entry ? 'Editar ' + catalogs[catalog].singular : 'Novo ' + catalogs[catalog].singular
  return <form className="ui-form ui-detail" onSubmit={save} aria-labelledby="catalog-form-title">
    <div className="ui-detail-header">
      <div>
        <h2 id="catalog-form-title">{title}</h2>
        {catalog === 'INSUMO' && entry && <p className="ui-muted">Código <span className="ui-code">{entry.code}</span> · Unidade {entry.unit ?? 'A validar'}</p>}
      </div>
      <button type="button" className="secondary" disabled={busy} onClick={onClose}><X aria-hidden="true" size={16}/>Fechar</button>
    </div>
    <fieldset className="ui-fieldset">
      <legend>Dados do cadastro</legend>
      {catalog === 'INSUMO' && !entry && <label>Código interno <input name="code" maxLength={60} required/></label>}
      <label>{catalogs[catalog].label}
        <input name="label" maxLength={catalog === 'LOCAL' ? 60 : 180} defaultValue={entry?.label ?? ''} required/>
      </label>
      {catalog === 'INSUMO' && !entry && <label>Unidade base
        <select name="unit" required><option value="">Selecione</option>
          {units.map(unit => <option key={unit}>{unit}</option>)}
        </select>
      </label>}
      <label className="ui-check"><input name="active" type="checkbox" defaultChecked={entry?.active !== false}/> Ativo</label>
    </fieldset>
    {error && <p className="ui-message" data-tone="danger" role="alert">{error}</p>}
    <div className="ui-form-actions">
      <button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancelar</button>
      <button disabled={busy}>{busy ? 'Salvando…' : 'Salvar cadastro'}</button>
    </div>
  </form>
}

export function OperationalCatalogs() {
  const [catalog, setCatalog] = useState<Catalog>('FORNECEDOR')
  const [editor, setEditor] = useState<Row | null | undefined>()
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const from = page * pageSize
  const to = from + pageSize - 1
  const list = useQuery({
    queryKey: ['operational-catalog', catalog, page, pageSize],
    placeholderData: previous => previous,
    queryFn: async (): Promise<{ rows: Row[]; count: number }> => {
      if (catalog === 'INSUMO') {
        const { data, count, error } = await supabase.from('items')
          .select('id,original_code,original_description,commercial_description,active,catalog_version,base_unit', { count: 'exact' })
          .eq('classification', 'INSUMO').order('original_code').range(from, to)
        if (error) throw error
        return { count: count ?? 0, rows: data.map(row => ({
          id: row.id, label: row.commercial_description ?? row.original_description, active: row.active,
          version: row.catalog_version, code: row.original_code, unit: row.base_unit,
        })) }
      }
      if (catalog === 'LOCAL') {
        const { data, count, error } = await supabase.from('locations').select('id,code,active,version', { count: 'exact' })
          .order('code').range(from, to)
        if (error) throw error
        return { count: count ?? 0, rows: data.map(row => ({ ...row, label: row.code })) }
      }
      const { data, count, error } = await supabase.from(catalogs[catalog].table).select('id,name,active,version', { count: 'exact' })
        .order('name').order('id').range(from, to)
      if (error) throw error
      return { count: count ?? 0, rows: data.map(row => ({ ...row, label: row.name })) }
    },
  })
  const stale = list.isPlaceholderData
  const columns: Column<Row>[] = [
    ...(catalog === 'INSUMO' ? [{ id: 'code', header: 'Código', cell: (row: Row) => <span className="ui-code">{row.code}</span> }] : []),
    { id: 'label', header: catalogs[catalog].label, cell: row => <strong>{row.label}</strong> },
    ...(catalog === 'INSUMO' ? [{ id: 'unit', header: 'Unidade', cell: (row: Row) => row.unit ?? <Badge tone="warning">A validar</Badge> }] : []),
    { id: 'status', header: 'Status', cell: row => <Badge tone={row.active ? 'success' : 'neutral'}>{row.active ? 'Ativo' : 'Inativo'}</Badge> },
  ]

  return <section className="panel">
    <PageHeader icon={Factory} title="Cadastros operacionais"
      description="Fornecedores, fabricantes, locais de estoque e insumos usados no recebimento e na produção."
      actions={editor === undefined && <button type="button" onClick={() => setEditor(null)}><Plus aria-hidden="true" size={16}/>Novo cadastro</button>}/>
    <Tabs label="Tipos de cadastro" value={catalog} onChange={key => { setCatalog(key); setPage(0); setEditor(undefined) }}
      items={(Object.keys(catalogs) as Catalog[]).map(key => ({ id: key, label: catalogs[key].title }))}/>
    {editor !== undefined && <CatalogForm key={catalog + (editor?.id ?? 'new')} catalog={catalog} entry={editor} onClose={() => setEditor(undefined)}/>}
    <DataTable caption={catalogs[catalog].title} rows={stale ? undefined : list.data?.rows} columns={columns} rowKey={row => row.id}
      loading={list.isFetching} error={list.isError} onRetry={() => void list.refetch()}
      total={list.data?.count ?? 0} page={page} pageSize={pageSize} onPageChange={setPage}
      onPageSizeChange={size => { setPageSize(size); setPage(0) }}
      empty={{ title: 'Nenhum cadastro', description: 'Use “Novo cadastro” para incluir o primeiro registro deste tipo.' }}
      onRowOpen={row => setEditor(row)}
      rowActions={row => <button className="secondary" type="button" onClick={() => setEditor(row)}>Editar</button>}/>
  </section>
}
