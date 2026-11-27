import {
  AlertTriangle, BarChart3, History, LayoutDashboard, Boxes, ClipboardList, Factory, FileBarChart, FlaskConical, Gauge, Link2, PackageSearch,
  Recycle, Settings2, ShieldAlert, ShoppingCart, Tablet, Tags, Truck, Tv, Upload, UserCog, Users, Workflow, type LucideIcon,
} from 'lucide-react'

export type Role = 'ADMINISTRADOR' | 'VENDAS' | 'PRODUCAO'
export type NavEntry = { id: string; title: string; icon: LucideIcon }
export type Department = { label: string; entries: NavEntry[] }

/** Organização dos menus da V2 (seção 11). Só módulos com tela existente entram aqui. */
export const departments: Department[] = [
  { label: 'Principal', entries: [
    { id: 'dashboard', title: 'Visão geral', icon: Gauge },
    { id: 'alerts', title: 'Central de alertas', icon: AlertTriangle },
  ] },
  { label: 'Comercial', entries: [
    { id: 'orders', title: 'Pedidos', icon: ShoppingCart },
    { id: 'customers', title: 'Clientes', icon: Users },
  ] },
  { label: 'Produção', entries: [
    { id: 'production-demand', title: 'Demanda de produção', icon: ClipboardList },
    { id: 'production-board', title: 'Kanban de produção', icon: Workflow },
    { id: 'terminal', title: 'Terminal da estação', icon: Tablet },
    { id: 'tv', title: 'Modo TV', icon: Tv },
    { id: 'recipes', title: 'Receitas', icon: FlaskConical },
  ] },
  { label: 'Estoque', entries: [
    { id: 'inventory', title: 'Painel de estoque', icon: Boxes },
  ] },
  { label: 'Logística', entries: [
    { id: 'shipping', title: 'Expedição', icon: Truck },
  ] },
  { label: 'Qualidade', entries: [
    { id: 'traceability', title: 'Rastreabilidade', icon: PackageSearch },
    { id: 'recall', title: 'Recolhimentos', icon: ShieldAlert },
    { id: 'losses', title: 'Desperdícios', icon: Recycle },
  ] },
  { label: 'Gestão', entries: [
    { id: 'panels', title: 'Painéis departamentais', icon: LayoutDashboard },
    { id: 'reports', title: 'Central de relatórios', icon: FileBarChart },
  ] },
  { label: 'Cadastros', entries: [
    { id: 'products', title: 'Produtos', icon: Tags },
    { id: 'operational-catalog', title: 'Insumos, fornecedores e locais', icon: Factory },
    { id: 'recipe-assignments', title: 'Associações de receitas', icon: Link2 },
  ] },
  { label: 'Administração', entries: [
    { id: 'profiles', title: 'Usuários e permissões', icon: UserCog },
    { id: 'import', title: 'Importação', icon: Upload },
    { id: 'activity', title: 'Linha do tempo', icon: History },
  ] },
]

export const fallbackIcon = BarChart3
export const settingsIcon = Settings2

const operational = new Set(['terminal', 'tv', 'production-demand', 'recipes', 'inventory', 'traceability', 'recall', 'losses'])
const commercial = new Set(['orders', 'customers'])
const administrative = new Set(['operational-catalog', 'recipe-assignments', 'import', 'profiles', 'activity'])
const shared = new Set(['dashboard', 'alerts', 'panels', 'reports', 'products', 'production-board', 'shipping'])

/** Espelha as regras de acesso do servidor; o banco continua sendo a autoridade (RLS e RPCs). */
export function canNavigate(id: string, role: string) {
  if (role !== 'ADMINISTRADOR' && role !== 'VENDAS' && role !== 'PRODUCAO') return false
  if (administrative.has(id)) return role === 'ADMINISTRADOR'
  if (operational.has(id)) return role !== 'VENDAS'
  if (commercial.has(id)) return role !== 'PRODUCAO'
  return shared.has(id)
}

export function findEntry(id: string) {
  for (const department of departments) {
    const entry = department.entries.find(item => item.id === id)
    if (entry) return { department, entry }
  }
  return null
}

export const roleLabels: Record<string, string> = {
  ADMINISTRADOR: 'Administração', PRODUCAO: 'Produção', VENDAS: 'Vendas',
}
