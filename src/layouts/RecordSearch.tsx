import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { highlightParts } from '../lib/text'

function Marked({ text, term }: { text: string; term: string }) {
  return <>{highlightParts(text, term).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</>
}

const categories = [
  ['products', 'Produtos'], ['customers', 'Clientes'], ['orders', 'Pedidos'], ['recipes', 'Receitas'], ['traceability', 'Lotes'],
  ['operational-catalog', 'Fornecedores e fabricantes'],
] as const
export type RecordMatch = { module: typeof categories[number][0]; record_id: string; label: string; reference: string }
const pageSize = 16

export function RecordSearch({ term, accountScope, onOpen }: {
  term: string; accountScope: string; onOpen: (record: RecordMatch) => void
}) {
  const [submitted, setSubmitted] = useState('')
  const [page, setPage] = useState(0)
  const current = term.trim()
  useEffect(() => {
    const timer = window.setTimeout(() => { setSubmitted(current); setPage(0) }, 300)
    return () => window.clearTimeout(timer)
  }, [current])
  const results = useQuery({
    queryKey: ['workspace-search', accountScope, submitted, page],
    enabled: current.length >= 2 && current === submitted,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.rpc('workspace_search', {
        search_text: submitted, page_offset: page * pageSize,
      }).abortSignal(signal)
      if (error) throw error
      return data as RecordMatch[]
    },
  })
  if (current.length < 2) return <p>Digite pelo menos dois caracteres para buscar registros.</p>
  if (current !== submitted || results.isPending) return <p role="status">Buscando registros…</p>
  if (results.isError) return <p role="alert">Não foi possível buscar registros. <button type="button" onClick={() => void results.refetch()}>Tentar novamente</button></p>

  const rows = results.data.slice(0, pageSize)
  return <>
    {!rows.length && <p>Nenhum registro encontrado nesta página.</p>}
    {categories.map(([module, title]) => {
      const found = rows.filter(row => row.module === module)
      return found.length > 0 && <section key={module}>
        <h3>{title}</h3>
        <ul>{found.map(record => <li key={record.record_id}>
          <button type="button" className="secondary" data-palette onClick={() => onOpen(record)}>
            <span><Marked text={record.reference} term={current}/> · <Marked text={record.label} term={current}/></span>
          </button>
        </li>)}</ul>
      </section>
    })}
    {(page > 0 || results.data.length > pageSize) && <nav aria-label="Páginas da busca">
      <button type="button" className="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
      <button type="button" className="secondary" disabled={results.data.length <= pageSize} onClick={() => setPage(page + 1)}>Próxima</button>
    </nav>}
  </>
}
