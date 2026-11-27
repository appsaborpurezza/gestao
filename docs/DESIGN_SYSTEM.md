# Design System — Sabor Purezza SMART

## Tokens
Definidos em `src/styles/tokens.css`, por significado (não por cor):

- Marca: `--color-brand-blue #07558B`, `--color-brand-navy #073B61`, `--color-brand-sky #1976B9`, `--color-brand-red #D51F28`, `--color-brand-yellow #F9D000`.
- Semânticos: `--color-primary`, `--color-secondary`, `--color-background`, `--color-surface`, `--color-text-primary`, `--color-text-muted`, `--color-border`, `--color-success|warning|danger|info` (com variantes `-soft` e `-ink` para fundos e texto de badge).
- Tipografia: `--font-sans`, escala `--text-xs` a `--text-display`, pesos `--weight-*`.
- Espaçamento: escala de 4 px (`--space-1` a `--space-10`).
- Raios (`--radius-sm|md|lg|pill`), sombras (`--shadow-sm|md|lg`), alturas (`--control-height` 44 px para toque), larguras do shell, camadas `--z-*`, movimento `--duration-*` (zerado com `prefers-reduced-motion`).

`--color-text-muted` usa `#526478` em vez de `#64748B` porque este não atinge 4,5:1 sobre `#F5F7FA`.

## Logo
Arquivo-fonte `public/logo.png` (1254×1254, PNG com transparência real). Versões geradas: `logo-32.png` (favicon), `logo-64.png` (sidebar), `logo-128.webp` (Modo TV), `logo-192.png` (apple-touch), `logo-320.webp` (login), `logo-512.png` (PDF), `icon-maskable-512.png` (PWA). O login caiu de 1,23 MB para 32 KB de imagem.

## Componentes base (`src/ui`)
`PageHeader`, `Badge`, `Skeleton`, `EmptyState`, `ErrorState`, `ForbiddenState`, `StatCard`. Ícones: `lucide-react` (importação por ícone, sem pacote completo).

## AppShell
`src/layouts/AppShell.tsx` e `src/styles/shell.css`. Sidebar azul-marinho com departamentos, recolhível só com ícones (preferência salva em `localStorage`), cabeçalho com breadcrumb, busca Ctrl+K, status de conexão, atalho de alertas e menu do usuário. Até 900 px a sidebar vira drawer.

## Navegação por URL
`src/lib/routes.ts`: rotas `#/modulo` e `#/modulo/<uuid>`, compatíveis com GitHub Pages (voltar, avançar, atualizar e link direto). Fragmentos de autenticação do Supabase são ignorados. O acesso continua decidido pelo servidor (RLS/RPC); endereços sem permissão exibem `ForbiddenState`.

## Componentes de cadastro (`src/ui/records.tsx`, `src/ui/toast.tsx`)
- `RecordActions`: "Editar" visível e menu de três pontos com as ações secundárias. Teclado: setas, Home, End, Esc (volta o foco ao botão). O menu é fixo na tela para não ser cortado pela rolagem da tabela.
- `lifecycleActions(active, open)`: Histórico, Dependências, Inativar ou Reativar (conforme a situação) e Excluir.
- `Modal`: `<dialog>` nativo com foco preso e retorno ao elemento de origem. `RecordDrawer`: formulário lateral (tela cheia no celular) que pede confirmação antes de descartar alterações.
- `CatalogLifecycleDialog`: prévia de dependências, exclusão com confirmação digitada, inativação com motivo, reativação e histórico paginado. Quem decide é o banco; a tela só apresenta.
- `SimilarRecords`: aviso não bloqueante de cadastros parecidos enquanto o usuário digita.
- `toast(texto, tom)` e `<Toaster/>`: aviso discreto, só depois da resposta definitiva do servidor.
- `friendlyError` (`src/lib/catalog.ts`): nunca mostra SQL cru. `useIdempotentRpc`: mesma chave `request_id` para reenvios do mesmo conteúdo.

Exemplo:
```tsx
const lifecycle = useLifecycle()
<DataTable rowActions={row => <RecordActions label={row.name} onEdit={() => edit(row)}
  actions={lifecycleActions(row.active, mode => lifecycle.open(row.id, mode))}/>} … />
<CatalogLifecycleDialog entity="FORNECEDOR" recordId={lifecycle.recordId} mode={lifecycle.mode}
  onClose={lifecycle.close} onModeChange={lifecycle.setMode} onDone={refresh}/>
```

## Workspace (`src/lib/workspace.ts`, `src/ui/QuickActions.tsx`)
- Favoritos, recentes e departamentos recolhidos por usuário em `localStorage` (`purezza:workspace:<id>`). Guarda apenas identificadores de módulos; permissões são revalidadas ao exibir.
- Estrela no cabeçalho marca a página atual como favorita; favoritos aparecem no topo da sidebar.
- Ações rápidas por perfil (`quickActions`), na Visão geral e na paleta Ctrl+K. Abrem o formulário por rota de ação (`#/orders/novo`, `#/inventory/receber`, `#/losses/registrar`); nunca gravam sozinhas. Depois de abrir, o endereço volta para `#/modulo`, para que atualizar a página não reabra o formulário.
- Paleta Ctrl+K: grupos Ações, Recentes, Módulos e Registros, destaque do trecho encontrado, setas/Home/End e Enter.

## Painéis departamentais

- Uma consulta por período e filtros alimenta as quatro abas; cada aba aparece só para o perfil que pode vê-la.
- Valores clicáveis nas tabelas (receita, cliente, classificação) aplicam o filtro em todos os painéis e aparecem como chips removíveis.
- Cartões de indicador levam ao módulo de detalhe (Kanban, Estoque, Desperdícios, Recolhimentos, Pedidos, Expedição).
- As mesmas tabelas (`panelSections`) geram a tela, o PDF, o Excel e a impressão; a impressão usa `.report-print` e esconde o restante da página.
