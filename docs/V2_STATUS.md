# Sabor Purezza SMART V2 — matriz de conclusão

Base da matriz: os 31 tópicos da especificação original e os critérios complementares de conclusão. O estado representa o tópico inteiro. A coluna **Evidência** identifica entregas parciais quando o tópico ainda está em desenvolvimento.

Atualizado em 27/11/2026. Portal de produção: [Sabor Purezza SMART](https://appsaborpurezza.github.io/gestao/). Produção tem 49 migrations (V1 001–041 e V2 001–008), aplicadas em 27/11/2026 após um backup lógico verificado por MD5. PRs integrados: #1 a #7.

**Limite da homologação:** o ambiente de desenvolvimento não alcança o Supabase pela rede. Por isso, as telas foram validadas com dados reais de homologação servidos por mocks, e as regras de banco foram validadas por SQL autenticado com usuários de teste. Em 27/11/2026 o E2E com login real (`e2e/smoke.mjs`, Playwright contra homologação) rodou no computador do usuário: 65 de 68 verificações passaram nos três perfis, no desktop e no celular. Passaram login, abertura de todos os módulos permitidos, bloqueio por perfil, busca sem acento e logout, sem erros de console nem respostas 5xx. As 3 falhas eram o seletor do roteiro para a busca global, já corrigido. A busca em si retornou 7 resultados.

**CRUD universal (V2.0, em andamento):** a matriz e o progresso por entidade estão em [CRUD_MATRIX.md](CRUD_MATRIX.md). Ciclo de vida dos cadastros (prévia de dependências, exclusão segura, inativação com motivo, reativação, histórico, aviso de duplicidade) está PUBLICADO desde 27/11/2026 (commit `834ffc9`, PRs #13 e #14), com a migration `20261127001000` aplicada em produção após backup verificado. A segunda rodada (receitas pelo portal, ações em massa, cadastro rápido de cliente e insumo, "Salvar e cadastrar outro", versões de embalagem e convites de usuários pela Edge Function `admin-users`) está IMPLEMENTADA e em homologação: veja a seção "Segunda rodada" da matriz.

| Tópico e requisito | Estado | Arquivos | Migration | Teste | Evidência | Pendências |
| --- | --- | --- | --- | --- | --- | --- |
| 01. Contexto e ambientes | PUBLICADO | README, workflow Pages | V1 001–041; V2 001–008 | Smoke do portal, deploy | Pages publicado a partir da `main` | — |
| 02. Objetivos de modernização | PUBLICADO | `src/styles/tokens.css`, `shell.css`, `src/ui`, módulos | — | Build, Vitest | PRs #6 a #8 | Módulos restantes no padrão (ver 09–10) |
| 03. Preservação da V1 | TESTADO | `supabase/migrations`, `foundation.test.ts` | Incrementais V2 | Regressão SQL (PGlite) | Nenhuma migration V1 alterada; RLS intacto; backup antes de cada mudança em produção | Regressão autenticada completa |
| 04. Identidade visual | PUBLICADO | `public/logo-*`, `index.html`, `Access.tsx`, `CommercialDocument.tsx` | — | Build | Logos otimizados (32 a 512 px, WebP), favicon, ícone maskable, PDF com logo de 512 px | Etiquetas internas |
| 05. Arquitetura React | IMPLEMENTADO | `main.tsx`, `layouts`, `features`, `ui` | — | TypeScript, build | Carregamento por módulo, componentes reutilizáveis | — |
| 06. AppShell e navegação | PUBLICADO | `AppShell.tsx`, `navigation.ts`, `routes.ts` | — | `routes.test.ts`, `appNavigation.test.ts` | Sidebar por departamento, recolhível, drawer, menu do usuário, status de conexão, rotas `#/modulo/<id>` | Validação autenticada em dispositivos reais |
| 07. Busca global | PUBLICADO | `RecordSearch.tsx` | V2 004, 007 | Acentos, paginação, acesso por perfil | Ctrl+K, lotes por código | OPs, massadas, fornecedores e expedições |
| 08. Padrão de buscas e filtros | PUBLICADO | `ui/filters.tsx`, módulos | V2 008 | `uiHelpers.test.ts`, `accentSearch.test.ts` | FilterBar, debounce, memória na sessão, períodos; busca sem acento no servidor; Expedição e Desperdícios; Rastreabilidade por abas | — |
| 09. Tabelas modernas | PUBLICADO | `ui/DataTable.tsx` | — | Build, capturas em 4 tamanhos | Produtos, Clientes, Pedidos, Estoque, Posição, Kanban (lista), Receitas, Expedição, Desperdícios, Cadastros operacionais, Rastreabilidade, Recolhimentos, Sessões de inventário | — |
| 10. Formulários | PUBLICADO | `ui/Combobox.tsx`, `Customers.tsx`, `Orders.tsx`, `Inventory.tsx` | — | Validações SQL V1 | Combobox, seções, aviso de não salvo em Clientes; painéis de detalhe com formulários em Expedição, Cadastros e Perdas | Aviso de não salvo nos demais formulários |
| 11. Dashboard executivo | PUBLICADO | `Dashboard.tsx`, `trend.ts` | V1 041 | `trend.test.ts`, Pareto, séries, exportações | Cards com tendência contra o período anterior e atalhos de detalhamento | Produtividade por etapa entregue nos Painéis departamentais (01300) |
| 12. Painéis departamentais | EM HOMOLOGAÇÃO | `panels/DepartmentPanels.tsx`, `panelData.ts` | V1 041, 01300 | `operationsPanels.test.ts` (4), `panelData.test.ts`, 66 verificações visuais em 5 resoluções e 3 perfis | Produção (planejado x realizado, rendimento por receita, produtividade e tempos líquidos por etapa, tempo do início à finalização), Estoque (situação, classificação, validade), Qualidade (perdas por motivo, destino e operação, peso abaixo do nominal, recolhimentos, liberação pendente), Comercial (pedidos, expedições, faturamento por cliente). Filtros reais por receita, cliente e classificação ao clicar nas tabelas; visualizações salvas; PDF, Excel e impressão por painel | Aplicar a migration 01300 em homologação e produção |
| 13. Kanban | EM HOMOLOGAÇÃO | `ProductionBoard.tsx`, `boardQuery.ts` | V2 001–003, 01200 | `boardState.test.ts`, `productionBoardQuery.test.ts`, 60 verificações visuais em 5 resoluções | Cards compactos, cor por etapa, prazo, painel lateral, lista em DataTable; indicadores calculados no servidor e clicáveis; kg por coluna e por cartão; filtros combináveis (situação, prazo, entrega de/até, OP, busca); ordenação; visualizações salvas; aba Por OP com progresso do lote | Aplicar a migration 01200 em homologação e produção. Arrastar e soltar não se aplica (ver nota abaixo) |
| 14. Realtime | PUBLICADO | `useBoardRealtime.ts` | V2 002–003 | SQL homologação | Canal único, pausa em aba oculta | Teste entre dois dispositivos |
| 15. Modo TV | EM HOMOLOGAÇÃO | `TvBoard.tsx` | V2 001–003, 01200 | Verificação visual sem nomes de clientes | Totais do servidor (massadas e kg em produção, finalizadas hoje, atrasadas, pausadas ou bloqueadas) e kg por etapa; sem valores comerciais | — |
| 16. Operação em tablets | EM DESENVOLVIMENTO | `ProductionBoard.tsx` | V1 029–039 | Capturas em tablet | Sidebar compacta, uma etapa por vez no celular | E2E em tablet. Terminal por estação com fila paginada de 30 em 30 e "Carregar mais" (01200) |
| 17. Estoque V2 | PUBLICADO | `features/inventory` | V1 003–010, 019, 034, 040 | `lotStatus.test.ts`, exportação | Lotes com filtros de situação e validade, ficha do lote pela URL, recebimento em seções, FEFO, posição por data, sessões de inventário com revisão por linha | — |
| 18. Pedidos V2 | PUBLICADO | `features/orders` | V1 012–023, 034; V2 008 | `uiHelpers.test.ts`, PDF | Lista com filtros, prazo, busca sem acento, Combobox; Expedição no novo padrão | — |
| 19. Receitas V2 | PUBLICADO | `RecipeList.tsx`, `RecipeReview.tsx` | V1 025–028, 033 | Build | Lista com busca por ingrediente e situação | Criação de receita nova pela interface |
| 20. Central de relatórios | PUBLICADO | `ReportCenter.tsx` | V1 009, 041 | PDF e Excel | Catálogo com filtros e prévia do painel; relatórios individuais de Produção, Estoque, Qualidade e Comercial (abrem o painel certo, com PDF, Excel e impressão) | — |
| 21. Alertas operacionais | PUBLICADO | `OperationalAlerts.tsx` | V2 005 | Smoke SQL | Cards por severidade com atalho | Abrir o registro exato |
| 22. Usuários e permissões | PUBLICADO; convites IMPLEMENTADOS em homologação | `ProfileManagement.tsx`, `supabase/functions/admin-users` | V2 006 | SQL homologação; telas simuladas | Gestão auditada de perfis, vínculo de contas, convite, reenvio, revogação de convite pendente e redefinição de senha | Teste com login real e publicação da Edge Function em produção |
| 23. Recursos do Supabase | EM DESENVOLVIMENTO | Consultas, índices trigram | V2 001–008 | Advisors | Consultas paginadas, índices de busca | Medição de Egress e Realtime com uso real |
| 24. Segurança | EM DESENVOLVIMENTO | RLS, RPCs | Todas | Advisor de produção (27/11) | Sem achados novos; `operation_requests` sem policy é intencional | Ativar proteção contra senhas vazadas no painel do Supabase (Auth) |
| 25. Estados da interface | PUBLICADO | `src/ui` | — | Build | Skeleton, vazio, erro e acesso negado padronizados nos módulos atualizados | Telas administrativas (perfis, importação, associações) |
| 26. Acessibilidade | EM DESENVOLVIMENTO | `tokens.css`, `src/ui` | — | Teclado | Contraste AA nos tokens, foco visível, ARIA no Combobox e nas abas | Auditoria WCAG com leitor de tela |
| 27. Testes automatizados | TESTADO | `tests`, `e2e/smoke.mjs` | V1 e V2 | 62 testes Vitest/PGlite; E2E autenticado com 3 perfis | Regressão local, migração com unaccent e E2E em homologação | Fluxos de escrita no E2E (pedido → OP → expedição) |
| 28. Metas de performance | EM DESENVOLVIMENTO | Build Vite | — | Build | Logo de login caiu de 1,23 MB para WebP de 320 px | Medição autenticada V1/V2 |
| 29. Estratégia de execução | PUBLICADO | PRs #1–#8 | V2 001–008 | CI em cada PR | Entregas incrementais | — |
| 30. Critérios de aceite | EM DESENVOLVIMENTO | Matriz e módulos | V1 e V2 | Regressão parcial | Linhas acima | Checklist autenticado |
| 31. Entrega final e evidências | EM DESENVOLVIMENTO | Este documento, README, capturas | V2 001–008 em produção | Regressão parcial | Backup verificado, publicação, capturas por módulo | Homologação autenticada |
| PWA (complementar) | PUBLICADO | `public/manifest.webmanifest` | — | Build | Manifesto com ícones e cor da marca | Service worker (fora do escopo) |

V1 001–041 refere-se à série `2026112400xxx`. V2 001–008 refere-se à série `20261127000x00`. Nomes exatos e ordenação estão em [supabase/migrations](../supabase/migrations).

## Painéis e relatórios (Etapa 3)

- `operations_panels(from_day, to_day, filters)` (migration 01300, somente leitura) calcula tudo no servidor. Filtros aceitos: `recipe`, `customer`, `classification`; qualquer outra chave é recusada (22023). Período máximo de 367 dias.
- Produção, Estoque e Qualidade: ADMINISTRADOR e PRODUCAO. Comercial, com valores: ADMINISTRADOR e VENDAS. Produção nunca recebe valores comerciais.
- Planejado x realizado considera as ordens com entrega no período; o realizado usa o peso medido ou, sem medição, o nominal. Rendimento compara o peso medido com o planejado só nas massadas medidas. Tempos por etapa são líquidos (pausas descontadas).
- A Visão geral (executivo, `role_dashboard`) continua igual.
## Kanban v2 (Etapa 2)

- `production_board_query(page_size, page_offsets, filters, sort)` substitui a leitura do quadro no frontend. Calcula no servidor os indicadores, os totais em kg, os grupos por OP e a paginação de cada coluna. `production_board_columns` continua disponível e não foi alterada.
- O Realtime continua invalidando o prefixo `['production-board','columns']`. Cada tela abre seu próprio canal, o que corrigiu a falha do terminal ao usar duas consultas na mesma página.
- A rastreabilidade individual não muda: cada cartão continua sendo uma massada, com o mesmo painel lateral e os mesmos registros.
- Arrastar e soltar: não se aplica. Cada mudança de etapa exige registros obrigatórios (checklist, medições, embalagem, lote), que só o formulário da etapa coleta. Arrastar um cartão daria a impressão de que a etapa foi concluída sem esses registros. A ação continua pelo botão da etapa no painel lateral e no terminal.

## Implantação e recuperação

1. Antes de qualquer migration em produção, gere o backup lógico (todas as tabelas de `public` e `purezza_private` como `jsonb`) e confira o MD5 com o calculado no servidor. O backup de 27/11/2026 está na pasta de arquivos do projeto (`backups/producao-20261127T0609Z`).
2. Aplique as migrations novas primeiro em homologação, valide com SQL autenticado e depois aplique em produção.
3. Publique o front somente depois das migrations de que ele depende. Exemplo: a busca de Clientes e Pedidos usa `search_text` (V2 008).
4. A publicação é manual: Actions → "Publicar no GitHub Pages" → Run workflow na `main`.
5. Em falha de frontend, republicar o último commit compatível no GitHub Pages preserva os dados. Reverta o banco somente por migration corretiva, nunca por reset.
