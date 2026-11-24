import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { previewImport } from './schema'

type Preview = Awaited<ReturnType<typeof previewImport>>
type Summary = Record<'produtos_inseridos' | 'produtos_existentes' | 'versoes_inseridas' | 'versoes_existentes', number>

export function ImportForm() {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const queryClient = useQueryClient()

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const files = new FormData(event.currentTarget)
    const products = files.get('products')
    const recipes = files.get('recipes')
    setBusy(true)
    setError('')
    setSummary(null)
    setPreview(null)
    try {
      setPreview(await previewImport(
        products instanceof File && products.size ? products : undefined,
        recipes instanceof File && recipes.size ? recipes : undefined,
      ))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível ler os arquivos.')
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    if (!preview || busy) return
    setBusy(true)
    setError('')
    try {
      const { data, error } = await supabase.rpc('import_preliminary', preview)
      if (error) throw new Error(error.message)
      setSummary(data as Summary)
      setPreview(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['items'] }),
        queryClient.invalidateQueries({ queryKey: ['recipes'] }),
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha na importação.')
    } finally {
      setBusy(false)
    }
  }

  return <section className="panel">
    <h2>Importação preliminar</h2>
    <form onSubmit={review} onChange={() => { setPreview(null); setSummary(null) }}>
      <label>Produtos em CSV <input type="file" name="products" accept=".csv" disabled={busy}/></label>
      <label>Receitas em JSON <input type="file" name="recipes" accept=".json" disabled={busy}/></label>
      <button disabled={busy}>Revisar arquivos</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {preview && <>
      <p>{preview.products.length} produtos e {preview.formulas.length} versões para revisão.</p>
      <ul>{preview.products.map(item => <li key={item.codigo_original}>{item.codigo_original} · {item.descricao_original}</li>)}</ul>
      <ul>{preview.formulas.map(recipe => <li key={recipe.codigo + '/' + recipe.versao}>{recipe.nome} · versão {recipe.versao}</li>)}</ul>
      <button onClick={confirm} disabled={busy}>Confirmar importação</button>
    </>}
    {summary && <p role="status">Produtos inseridos: {summary.produtos_inseridos}. Existentes: {summary.produtos_existentes}.
      Versões inseridas: {summary.versoes_inseridas}. Existentes: {summary.versoes_existentes}.</p>}
  </section>
}
