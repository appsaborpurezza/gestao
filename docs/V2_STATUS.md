# Sabor Purezza SMART V2 — matriz de conclusão

Base da matriz: os 31 tópicos da especificação original e os critérios complementares de conclusão. O estado representa o tópico inteiro. A coluna **Evidência** identifica entregas parciais quando o tópico ainda está em desenvolvimento.

Portal de produção: [Sabor Purezza SMART](https://appsaborpurezza.github.io/gestao/). Referência publicada confirmada: [commit b3b55c9](https://github.com/appsaborpurezza/gestao/commit/b3b55c92e7f9f0f2d02e3dc965c3494297164cd6). Produção tinha 46 migrations na inspeção anterior. A migration de perfis foi aplicada em homologação e rejeitada em produção pela revisão automática devido à falta de backup. [PR #5](https://github.com/appsaborpurezza/gestao/pull/5)

| Tópico e requisito | Estado | Arquivos | Migration | Teste | Evidência | Pendências |
| --- | --- | --- | --- | --- | --- | --- |
| 01. Contexto e ambientes | PUBLICADO | README, workflow Pages | V1 001–041; V2 001–005 | Smoke do portal | GitHub Pages e Supabase de produção implantados | — |
| 02. Objetivos de modernização | EM DESENVOLVIMENTO | `AppShell.tsx`, `styles.css`, módulos | V2 001–006 | Regressão local | PRs #1–#5 | Concluir módulos, usabilidade e desempenho |
| 03. Preservação da V1 | EM DESENVOLVIMENTO | `supabase/migrations`, `foundation.test.ts` | Incrementais V2 | Regressão SQL e build | Nenhuma migration V1 modificada | Regressão autenticada completa |
| 04. Identidade visual | EM DESENVOLVIMENTO | `public/logo.png`, `Access.tsx`, `styles.css` | — | Verificação pública do login | PR #3 | Auditoria de todas as telas, etiquetas e relatórios |
| 05. Arquitetura React | IMPLEMENTADO | `main.tsx`, `layouts`, `features` | — | TypeScript e build | Carregamento por módulo | — |
| 06. AppShell e navegação | EM DESENVOLVIMENTO | `AppShell.tsx`, `appNavigation.test.ts` | — | Acesso a módulos por perfil | PR #1 | Menu da conta e validação autenticada responsiva |
| 07. Busca global | EM DESENVOLVIMENTO | `RecordSearch.tsx`, `main.tsx` | V2 004 | Acentos, paginação e acesso | PR #2 e RPC testada em produção | Buscar OPs, massadas, lotes, fornecedores, fabricantes e expedições |
| 08. Padrão de buscas e filtros | EM DESENVOLVIMENTO | `RecordSearch.tsx`, `ProductionBoard.tsx`, `ReportCenter.tsx` | V2 001, 004 | Paginação e filtro do Kanban | Busca paginada existente | Cobertura uniforme de todos os módulos |
| 09. Tabelas modernas | EM DESENVOLVIMENTO | `styles.css`, listagens dos módulos | — | Build | Estilos comuns no PR #3 | Ordenação, colunas, densidade e auditoria responsiva |
| 10. Formulários | EM DESENVOLVIMENTO | Formulários dos módulos e `styles.css` | — | Validações SQL V1 | Fluxos existentes preservados | Combobox, confirmação e retenção de estado em todos os formulários |
| 11. Dashboard executivo | EM DESENVOLVIMENTO | `Dashboard.tsx`, `dashboardPeriods.ts` | V1 041 | Períodos, Pareto, série e exportações | Indicadores em produção, atalhos no PR #5 | Indicadores faltantes e navegação para detalhamento |
| 12. Painéis departamentais | NÃO INICIADO | — | — | — | Indicadores gerais existentes | Quatro painéis com filtros e detalhamento |
| 13. Kanban | EM DESENVOLVIMENTO | `ProductionBoard.tsx` e componentes produtivos | V2 001–003 | Paginação por coluna, RLS e regressão de etapas | Kanban publicado; lista por etapa e painel lateral em desenvolvimento | Visão por OP, filtros restantes e teste autenticado da lista |
| 14. Realtime | EM DESENVOLVIMENTO | `useBoardRealtime.ts` | V2 002–003 | Revisão e isolamento SQL em homologação | Postgres Changes configurado em produção | Teste de entrega entre dois dispositivos e medição |
| 15. Modo TV | EM DESENVOLVIMENTO | `ProductionBoard.tsx`, `styles.css` | V2 001–003 | Build e role gating | Gestão à Vista publicada | Indicadores, operação específica e teste em monitor |
| 16. Operação em tablets | EM DESENVOLVIMENTO | `ProductionBoard.tsx`, componentes de apontamento | V1 029–039 | Regressão SQL | Seletor de etapa e ações existentes | UX por estação e E2E em tablet |
| 17. Estoque V2 | EM DESENVOLVIMENTO | `features/inventory` | V1 003–010, 019, 034, 040 | Regressão de estoque | Recebimento, FEFO, inventários e rastreabilidade existentes | Painel, filtros completos e visão de lotes |
| 18. Pedidos V2 | EM DESENVOLVIMENTO | `features/orders` | V1 012–023, 034 | Regressão de pedidos, expedição e PDF | Módulos V1 preservados | Filtros, layout e histórico integrado |
| 19. Receitas V2 | EM DESENVOLVIMENTO | `features/recipes`, `ProductionDemand.tsx` | V1 025–028, 033 | Regressão de fichas e simulação | Revisão, aprovação, associação e planejamento existentes | Novas receitas e versões, pesquisa e revisão de interface |
| 20. Central de relatórios | EM DESENVOLVIMENTO | `ReportCenter.tsx`, `Dashboard.tsx`, exportadores | V1 009, 041 | Testes de PDF e Excel | Atalhos publicados; pesquisa, categorias e prévia do painel no desenvolvimento | Demais visualizações internas, filtros e saídas por relatório |
| 21. Alertas operacionais | EM DESENVOLVIMENTO | `OperationalAlerts.tsx` | V2 005 | Perfis, estado vazio, smoke SQL | Produção retornou nove receitas pendentes | Eventos restantes e acesso ao registro exato |
| 22. Usuários e permissões | BLOQUEADO | `ProfileManagement.tsx` | V2 006 | Edição, vínculo, auditoria, concorrência e proteção do perfil | Teste SQL em homologação, PR #5 | Convites, recuperação pelo portal, histórico na interface e backup para publicação |
| 23. Recursos do Supabase | EM DESENVOLVIMENTO | Lazy imports, consultas e Realtime | V2 001–005 | Build, advisors | Cache e consultas paginadas nas entregas V2 | Medições V1/V2 e avaliação de índices com volume representativo |
| 24. Segurança | EM DESENVOLVIMENTO | RLS, RPCs e cache de sessão | V1 001–041, V2 001–006 | RLS e tentativas sem perfil | Advisor de homologação registrou aviso informativo em `operation_requests` | Revisar após cada mudança, testar sessão real e fluxos de convite |
| 25. Estados da interface | EM DESENVOLVIMENTO | `AppShell.tsx`, módulos | — | Smoke de login e regressão | Estados de erro, vazio e conexão em módulos atualizados | Auditar cobertura e mensagens de todos os módulos |
| 26. Acessibilidade | EM DESENVOLVIMENTO | `AppShell.tsx`, `styles.css` | — | Navegação básica por teclado | Foco visível, rótulos e diálogo nativo | Auditoria WCAG, leitores de tela e dispositivos |
| 27. Testes automatizados | EM DESENVOLVIMENTO | `tests` | V1 e V2 | Vitest/PGlite | Regressão local com anexos reais em banco descartável | Cenários Playwright e três perfis reais em homologação |
| 28. Metas de performance | EM DESENVOLVIMENTO | Build Vite e consultas | V2 001–005 | Build; Performance Advisor anterior | Tamanhos do bundle disponíveis nos builds | Comparativo medido V1/V2, requisições, latência, Egress e logs |
| 29. Estratégia de execução | EM DESENVOLVIMENTO | Histórico local e PRs #1–#5 | V2 001–006 | Conjuntos por incremento | Entregas publicadas separadamente | Completar fases abertas |
| 30. Critérios de aceite | EM DESENVOLVIMENTO | Matriz, suíte e módulos | V1 e V2 | Regressão parcial | Evidências nas linhas anteriores | Checklist integral autenticado e validação visual |
| 31. Entrega final e evidências | EM DESENVOLVIMENTO | `docs/V2_STATUS.md`, README e PRs | V2 006 pendente em produção | Regressão parcial | Matriz registrada e links de publicação | Screenshots completos, relatórios finais, homologação e publicação |

V1 001–041 refere-se à série `2026112400xxx`. V2 001–006 refere-se à série `20261127000x00`. Nomes exatos e ordenação estão em [supabase/migrations](../supabase/migrations).

## Implantação e recuperação

O PR #5 permanece em rascunho enquanto a migration de perfis estiver bloqueada. Confirme o backup ou autorização específica e a restauração em ambiente separado antes de aplicar mudanças em produção. Publique os módulos dependentes somente após verificar as RPCs no ambiente alvo. Em falha de frontend, republicar o último commit compatível no GitHub Pages preserva os dados. Reverta o banco somente por procedimento validado ou migration corretiva, sem reset.
