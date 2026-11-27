# Auditoria UX — Sabor Purezza SMART

Data: 27/11/2026. Base: `main` em `65f4768`, mais os PRs abertos #13 (CRUD universal) e o desta etapa. Especificação: "UX Excellence".

## Método e limites
- **Ambiente**: o container de desenvolvimento não alcança o Supabase pela rede (o proxy recusa a conexão com 403). Por isso, o login real em homologação **não pôde ser exercitado daqui**. As telas foram auditadas com o build apontado para homologação e respostas simuladas a partir de dados reais de homologação. As regras de banco foram verificadas por SQL autenticado na homologação, em transações desfeitas.
- **Capturas**: Playwright em 1366×768, 1024×768 e 390×844 (Chrome headless). As capturas estão em `v2-crud/capturas` e `v2-ux/capturas` nos arquivos do projeto.
- **Medição** (login, build de produção servido localmente, CPU 4× mais lenta, 16 Mbit/s e 150 ms de latência): LCP 1,0 s, CLS 0, DOMContentLoaded 0,73 s. São 629 KB sem compressão, porque o servidor local não comprime. O pacote inicial comprimido tem cerca de 160 KB (`index` 101 KB + `supabase` 59 KB). ExcelJS (256 KB), jsPDF (128 KB) e jsQR (46 KB) só carregam quando a função é usada. Essas metas **ainda não foram medidas com dados reais e login**; ficam pendentes para o E2E no computador do usuário.

## Fluxos e esforço (Anexo A)

| Atividade | Antes | Depois desta etapa | Meta |
| --- | --- | --- | --- |
| Abrir novo pedido | 2 cliques (menu Pedidos → Novo pedido) | 1 clique (ação rápida na Visão geral) ou Ctrl+K "novo" + Enter | 1 clique |
| Receber material | 3 cliques (menu → Estoque → aba Recebimento) | 1 clique (ação rápida) | — |
| Registrar desperdício | 2 cliques | 1 clique (ação rápida) | — |
| Abrir edição a partir da listagem | 1–2 cliques (linha ou Editar) | igual, agora com gaveta lateral que preserva a lista | Até 2 |
| Localizar cadastro | Ctrl+K + digitação | igual, com destaque do trecho e navegação por setas | Até 3 interações |
| Excluir ou inativar cadastro | Não existia (só caixa "Ativo" no formulário) | Menu ⋮ → ação → confirmação (3 interações), com prévia de vínculos | — |
| Voltar a uma página frequente | Menu (1–2 cliques, rolagem em perfis com muitos módulos) | Favoritos no topo da sidebar, recentes no Ctrl+K | — |
| Cadastrar fornecedor durante recebimento | Sair do recebimento, ir a Cadastros, voltar e preencher de novo | "Novo fornecedor" ao lado do seletor: cadastra, seleciona e preserva o preenchimento (Administração) | Sem abandonar o formulário |
| Consultar pedidos atrasados | Filtros manuais | 1 clique (visualização "Atrasados") | 1 clique |

## Problemas encontrados

| # | Problema | Gravidade | Situação |
| --- | --- | --- | --- |
| 1 | Cadastros sem exclusão, inativação com motivo, prévia de dependências ou histórico | Alta | Resolvido no PR #13 (homologado, aguarda migration em produção) |
| 2 | Produtos sem inclusão, edição ou duplicação pela interface | Alta | Resolvido no PR #13 |
| 3 | Mesma tela inicial para todos os perfis, sem atalhos para a tarefa do dia | Alta | Resolvido: ações rápidas por perfil |
| 4 | Ctrl+K só navegava para módulos e registros, sem ações, recentes, destaque ou teclado | Média | Resolvido |
| 5 | Sidebar longa para Administração (19 módulos), sem favoritos nem recolher departamentos | Média | Resolvido: favoritos e departamentos recolhíveis, lembrados por usuário |
| 6 | Menu de ações em tabela seria cortado pela rolagem da tabela | Média | Resolvido: menu fixo que acompanha o botão |
| 7 | Formulários de cadastro inline empurravam a tabela; sem aviso ao descartar | Média | Resolvido nos cadastros com `RecordDrawer` |
| 8 | Mensagens de erro podiam expor texto do banco | Média | Resolvido com `friendlyError` |
| 9 | Cadastro rápido contextual (fornecedor no recebimento, cliente no pedido) | Média | Parcial: fornecedor e fabricante no recebimento; cliente no pedido pendente |
| 10 | Visualizações salvas e chips de filtro removíveis | Média | Resolvido em Pedidos (Atrasados, Entrega nesta semana, Rascunhos) e Clientes, com visualizações do usuário |
| 11 | Terminal de produção e modo TV dedicados | Alta | Resolvido: Terminal da estação (fila, próxima massada, ações do Kanban) e Modo TV dedicado (tela cheia, sem valores comerciais) |
| 12 | Timeline de atividades reutilizável em pedidos, OPs e lotes | Média | Parcial: histórico de cadastros pronto; demais registros pendentes |
| 13 | Onboarding e ajuda contextual | Baixa | Resolvido: primeiros passos por perfil na Visão geral e central de ajuda pesquisável no menu do usuário |

## Avaliação (Anexo C)
Ainda não pontuada: a nota exige pessoas reais. O roteiro está em `docs/UX_USABILITY_TEST.md` e a folha que calcula a nota ponderada em [Nota de UX SMART](https://claude.ai/artifact/A86jW6ct4NoviVEoD3U4xc). Os resultados de cada sessão entram aqui.
