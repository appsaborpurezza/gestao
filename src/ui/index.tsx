import type { ReactNode } from 'react'
import { AlertCircle, Inbox, Lock, RefreshCw, type LucideIcon } from 'lucide-react'

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export function PageHeader({ title, description, icon: Icon, actions }: {
  title: string; description?: ReactNode; icon?: LucideIcon; actions?: ReactNode
}) {
  return <header className="ui-page-header">
    {Icon && <span className="ui-page-header-icon" aria-hidden="true"><Icon size={22}/></span>}
    <div>
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
    {actions && <div className="ui-page-header-actions">{actions}</div>}
  </header>
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className="ui-badge" data-tone={tone}>{children}</span>
}

export function Skeleton({ lines = 3, label = 'Carregando…' }: { lines?: number; label?: string }) {
  return <div className="ui-skeleton" role="status" aria-live="polite">
    <span className="sr-only">{label}</span>
    {Array.from({ length: lines }, (_, index) => <span key={index} aria-hidden="true" style={{ width: `${92 - index * 14}%` }}/>)}
  </div>
}

export function EmptyState({ title, description, action, icon: Icon = Inbox }: {
  title: string; description?: ReactNode; action?: ReactNode; icon?: LucideIcon
}) {
  return <div className="ui-state">
    <Icon aria-hidden="true" size={28}/>
    <strong>{title}</strong>
    {description && <p>{description}</p>}
    {action}
  </div>
}

export function ErrorState({ title = 'Não foi possível carregar', description, onRetry }: {
  title?: string; description?: ReactNode; onRetry?: () => void
}) {
  return <div className="ui-state" data-tone="danger" role="alert">
    <AlertCircle aria-hidden="true" size={28}/>
    <strong>{title}</strong>
    {description && <p>{description}</p>}
    {onRetry && <button type="button" className="secondary" onClick={onRetry}><RefreshCw aria-hidden="true" size={16}/> Tentar novamente</button>}
  </div>
}

export function ForbiddenState({ description = 'Seu perfil não tem acesso a este módulo.' }: { description?: ReactNode }) {
  return <div className="ui-state" role="alert">
    <Lock aria-hidden="true" size={28}/>
    <strong>Acesso não autorizado</strong>
    <p>{description}</p>
  </div>
}

export function StatCard({ label, value, unit, context, icon: Icon, tone = 'neutral', onOpen }: {
  label: string; value: ReactNode; unit?: string; context?: ReactNode; icon?: LucideIcon; tone?: Tone; onOpen?: () => void
}) {
  const body = <>
    <span className="ui-stat-label">{Icon && <Icon aria-hidden="true" size={18}/>}{label}</span>
    <span className="ui-stat-value">{value}{unit && <small> {unit}</small>}</span>
    {context && <span className="ui-stat-context">{context}</span>}
  </>
  return onOpen
    ? <button type="button" className="ui-stat" data-tone={tone} onClick={onOpen}>{body}</button>
    : <div className="ui-stat" data-tone={tone}>{body}</div>
}
