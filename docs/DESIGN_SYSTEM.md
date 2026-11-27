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
