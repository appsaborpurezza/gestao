import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'

const catalogs = {
  FORNECEDOR: { title: 'Fornecedores', table: 'suppliers', label: 'Nome do fornecedor' },
  FABRICANTE: { title: 'Fabricantes', table: 'manufacturers', label: 'Nome do fabricante' },
  LOCAL: { title: 'Locais de estoque', table: 'locations', label: 'Código do local' },
  INSUMO: { title: 'Insumos', table: 'items', label: 'Descrição do insumo' },
} as const
type Catalog = keyof typeof catalogs
type Row = { id: string; label: string; active: boolean; version: number; code?: string; unit?: string | null }
const pageSize = 30
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

  return <form onSubmit={save}>
    {catalog === 'INSUMO' && !entry && <label>Código interno <input name="code" maxLength={60} required/></label>}
    {catalog === 'INSUMO' && entry && <p>Código {entry.code} · Unidade {entry.unit ?? 'A validar'}</p>}
    <label>{catalogs[catalog].label}
      <input name="label" maxLength={catalog === 'LOCAL' ? 60 : 180} defaultValue={entry?.label ?? ''} required/>
    </label>
    {catalog === 'INSUMO' && !entry && <label>Unidade base
      <select name="unit" required><option value="">Selecione</option>
        {units.map(unit => <option key={unit}>{unit}</option>)}
      </select>
    </label>}
    <label className="customer-check"><input name="active" type="checkbox" defaultChecked={entry?.active !== false}/> Ativo</label>
    {error && <p role="alert">{error}</p>}
    <div className="customer-actions">
      <button disabled={busy}>{busy ? 'Salvando…' : 'Salvar cadastro'}</button>
      <button type="button" className="secondary" disabled={busy} onClick={onClose}>Voltar</button>
    </div>
  </form>
}

export function OperationalCatalogs() {
  const [catalog, setCatalog] = useState<Catalog>('FORNECEDOR')
  const [editor, setEditor] = useState<Row | null | undefined>()
  const [page, setPage] = useState(0)
  const from = page * pageSize
  const to = from + pageSize - 1
  const list = useQuery({
    queryKey: ['operational-catalog', catalog, page],
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

  return <section className="panel">
    <h1>Cadastros operacionais</h1>
    {editor !== undefined ? <CatalogForm key={editor?.id ?? 'new'} catalog={catalog} entry={editor} onClose={() => setEditor(undefined)}/>
      : <>
        <nav aria-label="Tipos de cadastro">
          {(Object.keys(catalogs) as Catalog[]).map(key => <button type="button" key={key} aria-pressed={catalog === key}
            onClick={() => { setCatalog(key); setPage(0) }}>{catalogs[key].title}</button>)}
        </nav>
        <button type="button" onClick={() => setEditor(null)}>Novo cadastro</button>
        {list.isPending && <p role="status">Carregando cadastros…</p>}
        {list.isError && <p role="alert">Falha ao consultar os cadastros.</p>}
        {list.data?.rows.length === 0 && <p>Nenhum cadastro nesta página.</p>}
        {!!list.data?.rows.length && <div className="table-scroll"><table>
          <thead><tr><th>{catalogs[catalog].label}</th><th>Status</th><th>Ação</th></tr></thead>
          <tbody>{list.data.rows.map(row => <tr key={row.id}>
            <td>{catalog === 'INSUMO' ? row.code + ' · ' + row.label + ' · ' + (row.unit ?? 'Unidade a validar') : row.label}</td>
            <td>{row.active ? 'Ativo' : 'Inativo'}</td>
            <td><button className="secondary" type="button" onClick={() => setEditor(row)}>Editar</button></td>
          </tr>)}</tbody>
        </table></div>}
        {list.data && (list.data.count > pageSize || page > 0) && <nav aria-label="Páginas de cadastros">
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
          <span>Página {page + 1} · {list.data.count} registros</span>
          <button type="button" disabled={(page + 1) * pageSize >= list.data.count} onClick={() => setPage(page + 1)}>Próxima</button>
        </nav>}
      </>}
  </section>
}
