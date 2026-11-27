import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Ban, History, Link2, MoreVertical, Pencil, RotateCcw, Trash2, X, type LucideIcon } from 'lucide-react'
import { Badge, ErrorState, Skeleton } from './index'
import { toast } from './toast'
import { useDebouncedValue } from './filters'
import { supabase } from '../lib/supabase'
import {
  entityLabels, fetchCatalogHistory, fetchCatalogPreview, historyLabels, useIdempotentRpc,
  type CatalogEntity, type CatalogPreview,
} from '../lib/catalog'

function placeFor(rect: DOMRect) {
  const up = window.innerHeight - rect.bottom < 260
  return { top: up ? rect.top - 4 : rect.bottom + 4, right: window.innerWidth - rect.right, up }
}

export type RecordAction = { id: string; label: string; icon: LucideIcon; onSelect: () => void; danger?: boolean; hidden?: boolean }

/**
 * Ações por registro: "Editar" sempre visível e um menu de três pontos para as secundárias.
 * Navegável por teclado (setas, Home, End, Esc) e sem depender de hover.
 */
export function RecordActions({ label, onEdit, editLabel = 'Editar', actions }: {
  label: string; onEdit?: () => void; editLabel?: string; actions: RecordAction[]
}) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<{ top: number; right: number; up: boolean } | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const visible = actions.filter(action => !action.hidden)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false) }
    // O menu é fixo na tela para não ser cortado pela rolagem da tabela: acompanha o botão
    // e fecha apenas quando o botão sai da área visível.
    const dismiss = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) { setOpen(false); return }
      setPlace(placeFor(rect))
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    anchor.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus()
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])

  function onKey(event: React.KeyboardEvent) {
    const items = [...(anchor.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const move = (to: number) => { event.preventDefault(); items[(to + items.length) % items.length]?.focus() }
    if (event.key === 'ArrowDown') move(index + 1)
    else if (event.key === 'ArrowUp') move(index - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(items.length - 1)
    else if (event.key === 'Escape' || event.key === 'Tab') { setOpen(false); if (event.key === 'Escape') trigger.current?.focus() }
  }

  return <div className="ui-record-actions" ref={anchor}>
    {onEdit && <button type="button" className="secondary" onClick={onEdit}>
      <Pencil aria-hidden="true" size={16}/>{editLabel}<span className="sr-only"> {label}</span>
    </button>}
    {visible.length > 0 && <>
      <button type="button" ref={trigger} className="icon-button" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
        aria-label={'Mais ações para ' + label} title="Mais ações" onClick={() => { setPlace(placeFor(trigger.current!.getBoundingClientRect())); setOpen(value => !value) }}>
        <MoreVertical aria-hidden="true" size={18}/>
      </button>
      {open && place && <div className="ui-menu" role="menu" id={menuId}
        style={{ top: place.top, right: place.right, transform: place.up ? 'translateY(-100%)' : undefined }} aria-label={'Ações para ' + label} onKeyDown={onKey}>
        {visible.map(action => <button key={action.id} type="button" role="menuitem" tabIndex={-1} data-danger={action.danger || undefined}
          onClick={() => { setOpen(false); action.onSelect() }}>
          <action.icon aria-hidden="true" size={16}/>{action.label}
        </button>)}
      </div>}
    </>}
  </div>
}

/** Ações padrão de ciclo de vida para um cadastro com situação ativa/inativa. */
export function lifecycleActions(active: boolean | null, open: (mode: LifecycleMode) => void, options: { history?: boolean; remove?: boolean } = {}): RecordAction[] {
  return [
    { id: 'history', label: 'Histórico', icon: History, onSelect: () => open('history'), hidden: options.history === false },
    { id: 'deps', label: 'Dependências', icon: Link2, onSelect: () => open('dependencies') },
    { id: 'deactivate', label: 'Inativar', icon: Ban, onSelect: () => open('deactivate'), hidden: active !== true },
    { id: 'reactivate', label: 'Reativar', icon: RotateCcw, onSelect: () => open('reactivate'), hidden: active !== false },
    { id: 'delete', label: 'Excluir', icon: Trash2, onSelect: () => open('delete'), danger: true, hidden: options.remove === false },
  ]
}

/** Diálogo modal nativo com foco controlado e retorno ao elemento de origem. */
export function Modal({ open, title, onClose, children, wide, drawer, guard }: {
  open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; drawer?: boolean
  /** Retorna true para bloquear o fechamento (ex.: alterações não salvas). */
  guard?: () => boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const origin = useRef<Element | null>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) { origin.current = document.activeElement; dialog.showModal() }
    if (!open && dialog.open) dialog.close()
  }, [open])
  useEffect(() => () => { (origin.current as HTMLElement | null)?.focus?.() }, [])
  const requestClose = () => { if (!guard?.()) onClose() }
  return <dialog ref={ref} className={drawer ? 'ui-drawer' : 'ui-modal'} data-wide={wide || undefined} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); requestClose() }}
    onClose={() => { if (open) onClose(); (origin.current as HTMLElement | null)?.focus?.() }}>
    <header className="ui-modal-header">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="icon-button" aria-label="Fechar" onClick={requestClose}><X aria-hidden="true" size={20}/></button>
    </header>
    <div className="ui-modal-body">{open && children}</div>
  </dialog>
}

/**
 * Formulário lateral de inclusão e edição. Avisa antes de descartar alterações e não recarrega a página.
 * No celular ocupa a tela inteira.
 */
export function RecordDrawer({ open, title, subtitle, onClose, dirty, children }: {
  open: boolean; title: string; subtitle?: ReactNode; onClose: () => void; dirty: boolean; children: ReactNode
}) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => { if (!open) setConfirming(false) }, [open])
  return <Modal open={open} drawer title={<>{title}{subtitle && <small>{subtitle}</small>}</>} onClose={onClose}
    guard={() => { if (dirty && !confirming) { setConfirming(true); return true } return false }}>
    {confirming && <div className="ui-message" data-tone="danger" role="alert">
      Existem alterações não salvas.
      <span className="ui-inline-actions">
        <button type="button" className="secondary" onClick={() => setConfirming(false)}>Continuar editando</button>
        <button type="button" className="danger" onClick={onClose}>Descartar alterações</button>
      </span>
    </div>}
    {children}
  </Modal>
}

export type LifecycleMode = 'delete' | 'deactivate' | 'reactivate' | 'dependencies' | 'history'
const modeTitles: Record<LifecycleMode, string> = {
  delete: 'Excluir cadastro definitivamente?', deactivate: 'Inativar cadastro', reactivate: 'Reativar cadastro',
  dependencies: 'Dependências do cadastro', history: 'Histórico do cadastro',
}

function DependencyList({ preview }: { preview: CatalogPreview }) {
  if (!preview.dependencies.length) return <p className="ui-message" data-tone="success">Nenhuma dependência impeditiva encontrada.</p>
  return <ul className="ui-dependency-list" aria-label="Vínculos encontrados">
    {preview.dependencies.map(dep => <li key={dep.type + dep.label}><span>{dep.label}</span><Badge tone="info">{dep.count.toLocaleString('pt-BR')}</Badge></li>)}
  </ul>
}

function RecordIdentity({ entity, preview }: { entity: CatalogEntity; preview: CatalogPreview }) {
  return <dl className="ui-record-identity">
    <div><dt>Tipo de cadastro</dt><dd>{entityLabels[entity]}</dd></div>
    {preview.code && <div><dt>Código</dt><dd className="ui-code">{preview.code}</dd></div>}
    <div><dt>Nome</dt><dd>{preview.name}</dd></div>
    {preview.active !== null && <div><dt>Situação</dt><dd><Badge tone={preview.active ? 'success' : 'neutral'}>{preview.active ? 'Ativo' : 'Inativo'}</Badge></dd></div>}
  </dl>
}

/**
 * Prévia de dependências, exclusão segura, inativação, reativação e histórico.
 * A interface só apresenta o resultado: quem decide é o banco, revalidando dentro da transação.
 */
export function CatalogLifecycleDialog({ entity, recordId, mode, onClose, onDone, onModeChange }: {
  entity: CatalogEntity; recordId: string | null; mode: LifecycleMode | null
  onClose: () => void; onDone: (mode: LifecycleMode) => void; onModeChange: (mode: LifecycleMode) => void
}) {
  const open = Boolean(recordId && mode)
  const preview = useQuery({
    queryKey: ['catalog-preview', entity, recordId, mode],
    enabled: open && mode !== 'history',
    staleTime: 0, gcTime: 0,
    queryFn: () => fetchCatalogPreview(entity, recordId!),
  })
  const [historyPage, setHistoryPage] = useState(0)
  const history = useQuery({
    queryKey: ['catalog-history', entity, recordId, historyPage],
    enabled: open && mode === 'history',
    queryFn: () => fetchCatalogHistory(entity, recordId!, historyPage),
  })
  const { run, busy } = useIdempotentRpc()
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { setReason(''); setTyped(''); setError(''); setHistoryPage(0) }, [recordId, mode])

  const data = preview.data
  const confirmWord = data?.code ?? data?.name ?? ''

  async function act() {
    if (!data || !mode) return
    setError('')
    try {
      if (mode === 'delete') {
        await run('delete_catalog_record', { entity, record_id: data.record_id, expected_version: data.record_version, reason: reason || null },
          'Não foi possível excluir o cadastro.')
        toast(entityLabels[entity] + ' excluído.')
      } else {
        await run('set_catalog_active', { entity, record_id: data.record_id, expected_version: data.record_version,
          next_active: mode === 'reactivate', reason: reason || null }, 'Não foi possível alterar a situação.')
        toast(mode === 'reactivate' ? 'Cadastro reativado.' : 'Cadastro inativado.')
      }
      onDone(mode)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha na operação.')
      void preview.refetch()
    }
  }

  return <Modal open={open} title={mode ? modeTitles[mode] : ''} onClose={onClose} wide={mode === 'history'}>
    {mode === 'history' ? <>
      {history.isPending && <Skeleton lines={4} label="Carregando histórico…"/>}
      {history.isError && <ErrorState description={(history.error as Error).message} onRetry={() => void history.refetch()}/>}
      {history.data && (history.data.rows.length === 0 ? <p className="ui-muted">Nenhuma operação registrada.</p> :
        <ol className="ui-history">{history.data.rows.map(row => <li key={row.id}>
          <strong>{historyLabels[row.action] ?? row.action.replaceAll('_', ' ').toLowerCase()}</strong>
          <span className="ui-muted">{new Date(row.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} · {row.operator}</span>
          {typeof row.details.justificativa === 'string' && <span>{row.details.justificativa}</span>}
        </li>)}</ol>)}
      {history.data && history.data.total > 20 && <nav className="ui-inline-actions" aria-label="Páginas do histórico">
        <button type="button" className="secondary" disabled={historyPage === 0} onClick={() => setHistoryPage(page => page - 1)}>Anterior</button>
        <button type="button" className="secondary" disabled={(historyPage + 1) * 20 >= history.data.total} onClick={() => setHistoryPage(page => page + 1)}>Próxima</button>
      </nav>}
    </> : <>
      {preview.isPending && <Skeleton lines={4} label="Consultando dependências…"/>}
      {preview.isError && <ErrorState description={(preview.error as Error).message} onRetry={() => void preview.refetch()}/>}
      {data && mode && <>
        <RecordIdentity entity={entity} preview={data}/>
        {mode === 'dependencies' && <>
          <DependencyList preview={data}/>
          <div className="ui-modal-actions">
            {data.can_delete && <button type="button" className="danger" onClick={() => onModeChange('delete')}><Trash2 aria-hidden="true" size={16}/>Excluir</button>}
            {data.can_deactivate && <button type="button" className="secondary" onClick={() => onModeChange('deactivate')}><Ban aria-hidden="true" size={16}/>Inativar</button>}
            <button type="button" onClick={onClose}>Fechar</button>
          </div>
        </>}
        {mode === 'delete' && (data.can_delete ? <>
          <p className="ui-message" data-tone="success">Não foram encontradas dependências impeditivas.</p>
          <p>A exclusão é definitiva. O registro sai das listas e seleções, e a operação fica registrada na auditoria.
            Se algo for vinculado a este cadastro antes da confirmação, o sistema bloqueia a exclusão.</p>
          <label><span>Para confirmar, digite <strong className="ui-code">{confirmWord}</strong></span>
            <input value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off"/></label>
          <label>Justificativa (opcional) <input value={reason} maxLength={500} onChange={event => setReason(event.target.value)}/></label>
          {error && <p className="ui-message" data-tone="danger" role="alert">{error}</p>}
          <div className="ui-modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancelar</button>
            <button type="button" className="danger" disabled={busy || typed.trim().toLowerCase() !== confirmWord.trim().toLowerCase()} onClick={() => void act()}>
              <Trash2 aria-hidden="true" size={16}/>{busy ? 'Excluindo…' : 'Excluir definitivamente'}</button>
          </div>
        </> : <>
          <p className="ui-message" data-tone="danger">{data.reasons[0] ?? 'Este cadastro não pode ser excluído definitivamente.'}</p>
          {data.reasons.slice(1).map(text => <p key={text} className="ui-muted">{text}</p>)}
          <DependencyList preview={data}/>
          <div className="ui-modal-actions">
            <button type="button" className="secondary" onClick={onClose}>Cancelar</button>
            {data.can_deactivate && <button type="button" onClick={() => onModeChange('deactivate')}><Ban aria-hidden="true" size={16}/>Inativar cadastro</button>}
          </div>
        </>)}
        {mode === 'deactivate' && (data.can_deactivate ? <>
          <p>O cadastro deixa de aparecer nas novas operações. O histórico e as operações já registradas são preservados.</p>
          <label><span>Motivo da inativação <span className="ui-required" aria-hidden="true">*</span></span>
            <input value={reason} maxLength={500} required onChange={event => setReason(event.target.value)}/></label>
          {error && <p className="ui-message" data-tone="danger" role="alert">{error}</p>}
          <div className="ui-modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancelar</button>
            <button type="button" disabled={busy || !reason.trim()} onClick={() => void act()}>{busy ? 'Inativando…' : 'Inativar'}</button>
          </div>
        </> : <>
          <p className="ui-message" data-tone="danger">{data.active === false ? 'O cadastro já está inativo.' : 'Não é possível inativar agora.'}</p>
          {data.deactivation_blockers.length > 0 && <ul className="ui-plain-list">{data.deactivation_blockers.map(text => <li key={text}>{text}</li>)}</ul>}
          <div className="ui-modal-actions"><button type="button" onClick={onClose}>Fechar</button></div>
        </>)}
        {mode === 'reactivate' && <>
          <p>O cadastro volta a aparecer nas seleções. Reativar não libera lotes nem substitui aprovações técnicas.</p>
          {error && <p className="ui-message" data-tone="danger" role="alert">{error}</p>}
          <div className="ui-modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancelar</button>
            <button type="button" disabled={busy || !data.can_reactivate} onClick={() => void act()}>{busy ? 'Reativando…' : 'Reativar'}</button>
          </div>
        </>}
      </>}
    </>}
  </Modal>
}

/** Estado do diálogo de ciclo de vida para uma tela de cadastro. */
export function useLifecycle() {
  const [state, setState] = useState<{ id: string; mode: LifecycleMode } | null>(null)
  return {
    recordId: state?.id ?? null, mode: state?.mode ?? null,
    open: (id: string, mode: LifecycleMode) => setState({ id, mode }),
    setMode: (mode: LifecycleMode) => setState(current => current && { ...current, mode }),
    close: () => setState(null),
  }
}

/** Aviso não bloqueante de cadastros parecidos, consultado no banco enquanto o operador digita. */
export function SimilarRecords({ entity, term, excludeId }: { entity: CatalogEntity; term: string; excludeId?: string | null }) {
  const needle = useDebouncedValue(term.trim(), 400)
  const similar = useQuery({
    queryKey: ['catalog-similar', entity, needle, excludeId ?? null],
    enabled: needle.length >= 3,
    staleTime: 10_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('catalog_similar', { entity, term: needle, exclude_id: excludeId ?? null })
      // Sem a RPC (ambiente desatualizado) o aviso simplesmente não aparece.
      if (error) return []
      return data as { id: string; code: string | null; name: string; active: boolean }[]
    },
  })
  if (!similar.data?.length || needle.length < 3) return null
  return <div className="ui-message ui-similar" role="status">
    Cadastros parecidos já existem. Confira antes de salvar para evitar duplicidade:
    <ul className="ui-plain-list">{similar.data.map(row => <li key={row.id}>
      {row.code && row.code !== row.name && <span className="ui-code">{row.code} </span>}{row.name}{!row.active && ' (inativo)'}
    </li>)}</ul>
  </div>
}
