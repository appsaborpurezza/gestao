# Teste de usabilidade com usuários reais (seção 50 e Anexo C)

A nota de UX só vale medida com as pessoas que usam o sistema, no portal de produção e nos aparelhos reais. Este roteiro e a folha de nota ([Nota de UX SMART](https://claude.ai/artifact/A86jW6ct4NoviVEoD3U4xc)) padronizam a medição.

## Como conduzir
1. Uma pessoa por vez, no próprio perfil, sem ajuda de quem conduz (só observar e anotar).
2. Aparelhos: Administração no desktop, Vendas no notebook ou celular, Produção no tablet da estação.
3. Para cada tarefa, anotar tempo (do enunciado até concluir), cliques, erros (caminho errado, mensagem de erro, desistência) e se pediu ajuda.
4. No fim, a pessoa e quem conduz atribuem nota de 0 a 10 para cada critério do Anexo C. A folha calcula a nota ponderada.
5. Copiar o resultado ("Copiar resultado") e colar na conversa do projeto. A nota e as dificuldades entram em `docs/UX_AUDIT.md`.

Mínimo recomendado: 2 pessoas por perfil. Repetir depois de cada rodada de melhorias para comparar antes e depois.

## Tarefas
| Perfil | Tarefa | Meta (Anexo A) |
| --- | --- | --- |
| Administração | Localizar um produto pelo nome | Até 3 interações |
| Administração | Editar um cadastro e salvar | Até 2 cliques para abrir |
| Administração | Inativar um fornecedor sem uso recente | Com motivo |
| Administração | Revisar uma receita pendente | — |
| Administração | Abrir Usuários e permissões | 1 clique |
| Vendas | Localizar um cliente | Até 3 interações |
| Vendas | Criar um pedido | 1 clique para abrir |
| Vendas | Ver pedidos atrasados | 1 clique |
| Vendas | Consultar o andamento de um pedido | — |
| Vendas | Emitir o documento comercial | — |
| Produção | Escolher a estação no terminal | 1 vez por aparelho |
| Produção | Localizar a próxima massada | Já em destaque |
| Produção | Iniciar ou retomar a etapa | Até 2 interações |
| Produção | Selecionar lote e registrar quantidade | Sem digitação desnecessária |
| Produção | Finalizar a etapa | — |

Use apenas registros reais do dia; não crie pedidos, lotes ou cadastros de teste em produção.

## Critérios e pesos (Anexo C)
Facilidade de utilização 20%, Modernidade visual 15%, Rapidez percebida 15%, Pesquisas e filtros 10%, Formulários inteligentes 10%, Kanban e produção 15%, Responsividade 10%, Acessibilidade 5%. Nota = soma de (nota × peso ÷ 10). Meta: 90.
