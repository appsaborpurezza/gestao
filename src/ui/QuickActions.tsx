import { ClipboardPlus, Factory, PackagePlus, PackageSearch, Recycle, ShoppingCart, Truck, UserCog, UserPlus, Workflow, type LucideIcon } from 'lucide-react'
import { canNavigate } from '../layouts/navigation'
import { actionsFor, type QuickAction } from '../lib/workspace'

const icons: Record<string, LucideIcon> = {
  'orders:novo': ShoppingCart, 'customers:novo': UserPlus, 'production-board': Workflow, 'inventory:receber': PackagePlus,
  traceability: PackageSearch, 'losses:registrar': Recycle, 'products:novo': ClipboardPlus, 'operational-catalog:novo': Factory,
  orders: ShoppingCart, shipping: Truck, profiles: UserCog,
}

/** Atalhos do perfil para as tarefas mais frequentes. Só aparecem ações autorizadas. */
export function QuickActions({ role, onAction }: { role: string; onAction: (action: QuickAction) => void }) {
  const actions = actionsFor(role).filter(action => canNavigate(action.module, role))
  if (!actions.length) return null
  return <nav aria-label="Ações rápidas"><ul className="ui-quick-actions">
    {actions.map(action => {
      const Icon = icons[action.id] ?? Workflow
      return <li key={action.id}><button type="button" title={action.hint} onClick={() => onAction(action)}>
        <Icon aria-hidden="true" size={16}/>{action.title}
      </button></li>
    })}
  </ul></nav>
}
