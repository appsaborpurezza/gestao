import { useState } from 'react'
import { Ban, Download, RotateCcw, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { entityLabels, friendlyError, type CatalogEntity, type CatalogPreview } from '../lib/catalog'
import { downloadFile } from '../lib/downloadFile'
import { Modal } from './records'
import { Badge } from './index'
import { toast } from './toast'

export type BulkRow = { id: string; label: string; active: boolean | null; cells: Record<string, string | number | null> }
type Outcome = { id: string; label: string; ok: boolean; message: string }

const csvCell = (value: string | number | null) => {
  const text = value === null ? '' : String(value)
  return /[";\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text
}

/** CSV com ponto e vírgula e BOM, para abrir direto no Excel em português. */
export function exportRowsCsv(rows: BulkRow[], filename: string) {
  const headers = Object.keys(rows[0]?.cells ?? {})
  const lines = [headers.map(csvCell).join(';'), ...rows.map(row => headers.map(header => csvCell(row.cells[header] ?? null)).join(';'))]
  downloadFile(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), filename)
}

/**
 * Ações em massa sobre a seleção: exportar, inativar e reativar. Cada registro passa pela mesma RPC
 * da ação individual (permissão, versão, vínculos e motivo conferidos no banco), um por vez, e o
 * resultado é mostrado por registro. Exclusão definitiva em massa não é oferecida.
 */
export function BulkActions({ entity, rows, canChange, filename, onClear, onDone }: {
  entity: CatalogEntity; rows: BulkRow[]; canChange: boolean; filename: string; onClear: () => void; onDone: () => void
}) {
  const [mode, setMode] = useState<'deactivate' | 'reactivate' | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Outcome[] | null>(null)
  if (!rows.length) return null
  const targets = rows.filter(row => mode === 'deactivate' ? row.active === true : row.active === false)

  async function apply() {
    if (!mode) return
    setBusy(true)
    const outcomes: Outcome[] = []
    for (const row of targets) {
      try {
        const { data, error } = await supabase.rpc('catalog_dependencies', { entity, record_id: row.id })
        if (error) throw error
        const preview = data as CatalogPreview
        if (mode === 'deactivate' && !preview.can_deactivate) throw new Error(preview.deactivation_blockers[0] ?? 'Não pode ser inativado agora.')
        const result = await supabase.rpc('set_catalog_active', {
          entity, record_id: row.id, expected_version: preview.record_version, next_active: mode === 'reactivate',
          reason: mode === 'deactivate' ? reason.trim() : null, request_id: crypto.randomUUID(),
        })
        if (result.error) throw result.error
        outcomes.push({ id: row.id, label: row.label, ok: true, message: mode === 'deactivate' ? 'Inativado' : 'Reativado' })
      } catch (cause) {
        const message = cause instanceof Error && !('code' in cause) ? cause.message : friendlyError(cause as { code?: string; message?: string }, 'Não foi possível concluir.')
        outcomes.push({ id: row.id, label: row.label, ok: false, message })
      }
    }
    setResults(outcomes)
    setBusy(false)
    const ok = outcomes.filter(item => item.ok).length
    toast(`${ok} de ${outcomes.length} ${mode === 'deactivate' ? 'inativados' : 'reativados'}.`, ok === outcomes.length ? 'success' : 'info')
    onDone()
  }
  const close = () => { setMode(null); setReason(''); setResults(null) }

  return <div className="ui-bulk-bar" role="region" aria-label="Ações para os selecionados">
    <strong>{rows.length} {rows.length === 1 ? 'selecionado' : 'selecionados'}</strong>
    <button type="button" className="secondary" onClick={() => exportRowsCsv(rows, filename)}><Download aria-hidden="true" size={16}/>Exportar</button>
    {canChange && <>
      <button type="button" className="secondary" disabled={!rows.some(row => row.active === true)} onClick={() => setMode('deactivate')}><Ban aria-hidden="true" size={16}/>Inativar</button>
      <button type="button" className="secondary" disabled={!rows.some(row => row.active === false)} onClick={() => setMode('reactivate')}><RotateCcw aria-hidden="true" size={16}/>Reativar</button>
    </>}
    <button type="button" className="ui-link-button" onClick={onClear}><X aria-hidden="true" size={14}/>Limpar seleção</button>
    <Modal open={mode !== null} title={mode === 'deactivate' ? 'Inativar selecionados' : 'Reativar selecionados'} onClose={() => { if (!busy) close() }}>
      {results ? <div className="ui-form">
        <p>{results.filter(item => item.ok).length} de {results.length} concluídos. Os demais continuam como estavam.</p>
        <ul className="ui-dependency-list" aria-label="Resultado por registro">
          {results.map(item => <li key={item.id}><span>{item.label}<small className="ui-muted"> · {item.message}</small></span>
            <Badge tone={item.ok ? 'success' : 'danger'}>{item.ok ? 'Concluído' : 'Não alterado'}</Badge></li>)}
        </ul>
        <div className="ui-modal-actions"><button type="button" onClick={() => { close(); onClear() }}>Fechar</button></div>
      </div> : <form className="ui-form" onSubmit={event => { event.preventDefault(); void apply() }}>
        <p>{targets.length} de {rows.length} {entityLabels[entity].toLowerCase()}(s) selecionados serão {mode === 'deactivate' ? 'inativados' : 'reativados'}.
          {targets.length < rows.length && ' Os que já estão nessa situação são ignorados.'}</p>
        <p className="ui-muted">Cada registro é conferido pelo banco, um por vez: vínculos, operações em andamento e duplicidade. Falhas aparecem por registro.</p>
        {mode === 'deactivate' && <label><span>Motivo <span className="ui-required" aria-hidden="true">*</span></span>
          <input value={reason} required minLength={3} maxLength={500} onChange={event => setReason(event.target.value)}/></label>}
        <div className="ui-modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>Cancelar</button>
          <button disabled={busy || !targets.length}>{busy ? 'Aplicando…' : mode === 'deactivate' ? 'Inativar' : 'Reativar'}</button>
        </div>
      </form>}
    </Modal>
  </div>
}

/** Seleção que sobrevive à troca de página: guarda as linhas escolhidas, não só as chaves. */
export function useRowSelection<Row>(key: (row: Row) => string, available: Row[] | undefined) {
  const [picked, setPicked] = useState<Map<string, Row>>(() => new Map())
  const selected = new Set(picked.keys())
  const onChange = (next: Set<string>) => setPicked(current => {
    const map = new Map<string, Row>()
    for (const id of next) {
      const row = current.get(id) ?? available?.find(item => key(item) === id)
      if (row) map.set(id, row)
    }
    return map
  })
  return { selected, rows: [...picked.values()], onChange, clear: () => setPicked(new Map()) }
}
