# Matriz CRUD dos cadastros — Sabor Purezza SMART V2

Auditoria da Fase A da especificação "CRUD universal, gestão de cadastros, UX inteligente e performance".
Data: 27/11/2026. Commit de referência: `65f4768` (main após o PR #12). Migrations: 50, idênticas em homologação e produção.
Suíte local: 62 testes Vitest/PGlite aprovados (1 ignorado). Nenhum PR aberto.

A estrutura abaixo foi lida do PostgreSQL de homologação (`information_schema`, `pg_constraint`, `pg_proc`), e não só do código.

## Como ler

- **Hoje**: o que o portal faz agora.
- **Alvo**: o que a especificação pede para a entidade, já filtrado pelas regras de rastreabilidade.
- Estados: IMPLEMENTADO, TESTADO, HOMOLOGADO, PUBLICADO, PENDENTE, BLOQUEADO.
- "Excluir" significa exclusão definitiva, só quando o banco confirmar que não há dependência. Nunca usa `ON DELETE CASCADE` e nenhuma FK é alterada.

## Resumo

| Entidade | Tabela | Incluir | Consultar | Editar | Excluir | Inativar | Reativar | Situação |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Clientes | `customers` | Sim | Sim | Sim | Sim, se nunca usado (Administração) | Sim, com motivo (Administração) | Sim | HOMOLOGADO (aguarda produção) |
| Produtos (acabados, terceiros, revenda) | `items` | Sim (`save_item`) e Duplicar | Sim | Descrição comercial e classificação | Sim, se nunca usado | Sim, com motivo | Sim | HOMOLOGADO (aguarda produção) |
| Insumos e embalagens | `items` (`INSUMO`) | Sim | Sim | Descrição comercial | Sim, se nunca usado | Sim, com motivo | Sim | HOMOLOGADO (aguarda produção) |
| Fornecedores | `suppliers` | Sim | Sim | Sim | Sim, se nunca usado | Sim, com motivo | Sim | HOMOLOGADO (aguarda produção) |
| Fabricantes | `manufacturers` | Sim | Sim | Sim | Sim, se nunca usado | Sim, com motivo | Sim | HOMOLOGADO (aguarda produção) |
| Locais de estoque | `locations` | Sim | Sim | Sim | Sim, se nunca usado | Sim, bloqueia com saldo ou sessão aberta | Sim | HOMOLOGADO (aguarda produção) |
| Motivos de perda | `loss_reasons` | Sim | Sim | Não | Sim, se nunca usado | Sim, com motivo | Sim | HOMOLOGADO (aguarda produção) |
| Destinações de perda | `loss_destinations` | Sim (exige liberação sanitária) | Sim | Não | Sim, se nunca usada | Sim, com motivo | Sim | HOMOLOGADO (aguarda produção) |
| Receitas | `recipes` | Não | Sim | Não | Não | Não existe situação | — | PENDENTE |
| Versões de receita | `recipe_versions` + `recipe_reviews` | Não | Sim | Sim, revisão técnica de versão pendente | Não | — | — | PUBLICADO parcial (revisar e aprovar) |
| Associações produto/cliente/receita | `customer_product_recipes` | Sim | Sim | Substituir | Não | Encerrar vigência | — | PUBLICADO (modelo de vigência, sem exclusão) |
| Configurações de embalagem | `product_packaging_configs` | Sim, nova versão | Sim | Nova versão | Não | — | — | PUBLICADO (versionado) |
| Conversões de unidade | `item_unit_conversions` | Sim, nova versão | Sim | Nova versão | Não | — | — | PUBLICADO (versionado) |
| Usuários e perfis | `profiles` + Auth | Vincular conta já criada | Sim | Perfil, permissões, ativo | Não (correto) | Sim | Sim | PUBLICADO parcial: falta convite, reenvio, revogação e senha |
| Documento comercial (configuração) | `commercial_document_settings` | Configurar | Sim | Sim | — | — | — | PUBLICADO |
| Categorias, unidades, classificações, etapas | `CHECK` nas tabelas | Fixas | — | — | — | — | — | Estruturais, mantidas fixas (ver seção própria) |

Registros transacionais não entram no CRUD de exclusão: pedidos, OPs, massadas, etapas, consumos, lotes, movimentos, reservas, expedições, devoluções, faturamento, documentos emitidos, perdas, descartes, inventários, recolhimentos, liberações, aprovações e `audit_logs`. Eles continuam com cancelamento, estorno, encerramento ou correção auditada, como já funciona.

## Progresso em 27/11/2026

- **Fase B (backend)**: migration `20261127001000_catalog_lifecycle.sql` aplicada na homologação e verificada por SQL autenticado: prévia de dependências, exclusão bloqueada com histórico (23503), versão antiga recusada (40001), código duplicado (23505), idempotência por `request_id`, histórico, inativação e reativação, e recusa para perfis sem permissão (42501). Produção ainda não tem a migration.
- **Fases C e D (telas)**: componentes `RecordActions`, `Modal`, `RecordDrawer`, `CatalogLifecycleDialog`, `SimilarRecords` e avisos (`toast`). Aplicados em Cadastros operacionais (fornecedores, fabricantes, locais, insumos), Produtos (novo, editar, duplicar), Clientes (ciclo de vida só para Administração) e Motivos e destinações de perda.
- **Testes**: Vitest 71 (70 passam, 1 ignorado); 64 verificações de tela com respostas simuladas em notebook, tablet e celular, para os perfis Administração e Vendas. O ambiente de desenvolvimento não alcança o Supabase pela rede, então o login real não pôde ser exercitado daqui.
- **Pendente**: receitas (decisão de modelagem para "descontinuar"), usuários via Edge Function, aplicação em produção com backup.

## Detalhe por entidade

### Clientes — `customers`

- **Chave**: `id uuid`. Número sequencial `customer_number` (único).
- **Campos**: tipo PF/PJ, razão social, fantasia, documento (único, validado por `valid_customer_document`), IE, endereço completo, contatos, condições de pagamento, observações, `active`, `version`, autoria e datas, `search_text` (busca sem acento).
- **Dependências (FK)**: `orders.customer_id`, `customer_product_recipes.customer_id`.
- **RPC atual**: `save_customer` (inclui e edita com versão e `request_id`). Leitura direta por RLS (Administração e Vendas).
- **Hoje**: inclusão, edição, ativo/inativo no formulário, busca sem acento, filtros por situação e UF.
- **Falta**: exclusão elegível (cliente sem pedido nem associação), ações de inativar e reativar fora do formulário, prévia de dependências e histórico.
- **Regras alvo**: exclusão só sem pedidos nem associações de receita. Inativação bloqueada com pedido em aberto (não entregue nem cancelado). Reativação confere documento duplicado.

### Produtos — `items` (TERCEIRO, FABRICACAO_PROPRIA, REVENDA_A_VALIDAR, FARINHA_USO_REVENDA_A_VALIDAR)

- **Chave**: `id uuid`. Código `original_code` (único).
- **Campos**: `original_code`, `original_description` (preservada para auditoria), `commercial_description`, `classification`, `validation_status`, `base_unit`, `unit_version`, `catalog_version`, `active`, `created_at`.
- **Não existem hoje**: categoria, observações, fabricante padrão, peso por embalagem no próprio item. Peso fica em `item_unit_conversions`, e fabricante, embalagem e etiqueta ficam em `product_packaging_configs`.
- **Dependências (FK)**: `order_items`, `inventory_lots`, `production_demands`, `customer_product_recipes`, `product_packaging_configs` (produto, embalagem e etiqueta), `item_unit_conversions`, `recipe_ingredients`, `recipe_review_ingredients`, `batch_ingredient_consumptions`, `batch_packaging_consumptions`.
- **RPCs atuais**: `configure_item_units`, `save_packaging_config`, `import_preliminary` (carga inicial).
- **Hoje**: consulta com filtros, unidade e conversão, configuração de embalagem.
- **Falta**: novo produto, edição da descrição comercial e da classificação, duplicar, inativar, reativar, excluir elegível e histórico.
- **Regras alvo**:
  - O código é imutável depois de usado.
  - A descrição original nunca é editada.
  - A classificação só muda sem pedidos, lotes, demandas nem associações.
  - A unidade base só muda pelo fluxo de unidades já existente, que é versionado.
  - Exclusão só sem nenhuma das FKs acima.
  - Inativar bloqueia novos pedidos e OPs. Fica bloqueado com saldo físico, reserva ativa ou pedido em aberto.
  - Duplicar copia classificação, unidade e descrição comercial, nunca lotes, conversões aprovadas nem embalagem.

### Insumos e embalagens — `items` (`INSUMO`)

- Mesma tabela e dependências dos produtos.
- **RPC atual**: `save_operational_catalog('INSUMO')`, que inclui com código e unidade e edita descrição comercial e ativo.
- **Falta**: excluir elegível, prévia de dependências, histórico e bloqueio de inativação com saldo.
- **Regras alvo**: exclusão só sem lote, receita, revisão, consumo nem configuração de embalagem.

### Fornecedores — `suppliers`, Fabricantes — `manufacturers`

- **Campos**: `id`, `name`, `active`, `version`. A unicidade do nome (sem diferenciar maiúsculas) é garantida na RPC com trava consultiva.
- **Dependências**: fornecedor em `receipts.supplier_id`. Fabricante em `inventory_lots.manufacturer_id` e `product_packaging_configs.manufacturer_id`.
- **RPC atual**: `save_operational_catalog` (inclui, edita, ativa e inativa com versão).
- **Falta**: excluir elegível, ações rápidas de inativar e reativar, prévia de dependências e histórico.
- **Regras alvo**: exclusão só sem recebimentos (fornecedor) ou sem lotes e embalagens (fabricante). Reativar não desbloqueia lote nenhum.

### Locais de estoque — `locations`

- **Campos**: `id`, `code` (único), `active`, `version`.
- **Dependências**: `stock_balances`, `inventory_lots.opening_location_id`, `inventory_sessions`, `inventory_counts`. Movimentos e reservas apontam para saldos.
- **Hoje**: a inativação já é bloqueada com saldo físico ou sessão aberta.
- **Falta**: excluir elegível (sem saldos históricos, lotes de abertura nem sessões), prévia e histórico.

### Motivos de perda — `loss_reasons`, Destinações — `loss_destinations`

- **Campos**: motivo com `id`, `name` (único sem diferenciar maiúsculas), `active`. Destinação com `name`, `authorization_reference`, `authorized_by`, `created_at`, `active`.
- **Não possuem** `version`. A migration incremental vai adicionar o campo com valor padrão 1, sem alterar os dados.
- **Dependências**: `production_losses`, `stock_waste_records`.
- **RPC atual**: `add_loss_option` (só inclusão).
- **Falta**: editar nome, inativar, reativar, excluir elegível e histórico. A destinação continua exigindo `can_release_lot`.

### Receitas — `recipes`, `recipe_versions`, `recipe_ingredients`, `recipe_reviews`, `recipe_approvals`

- **Situações possíveis hoje**: `PENDENTE_VALIDACAO` e `APROVADA`. Não existe rascunho nem descontinuada.
- **Dependências da versão**: `recipe_ingredients` e `recipe_versions` com `RESTRICT`, `recipe_reviews`, `recipe_approvals`, `customer_product_recipes`, `stock_reservations`, `production_losses`. Massadas e OPs ligam a versão pela associação.
- **RPCs atuais**: `save_recipe_review` (edição técnica versionada) e `approve_recipe_version` (exige `can_approve_recipe`).
- **Falta**: nova receita, nova versão (copiada da aprovada, iniciando pendente), duplicar, excluir versão pendente sem uso, descontinuar.
- **Regras alvo**:
  - Versão aprovada é imutável. Qualquer mudança vira nova versão.
  - Excluir só versão pendente sem aprovação, associação, reserva, perda ou massada.
  - "Descontinuar" exige uma situação nova, que entra por migration incremental após decisão de modelagem: a versão sai das associações vigentes e não volta sem nova aprovação.

### Associações — `customer_product_recipes`

- Modelo de vigência: `starts_at`, `ends_at` e `end_reason`, com índice único para a associação vigente.
- **RPC**: `save_recipe_assignment` (cria, substitui e encerra).
- **Dependência**: `production_orders.assignment_id`.
- **Alvo**: manter o modelo. Excluir só associação encerrada nunca usada em OP, se houver demanda real. Hoje fica PENDENTE de baixa prioridade.

### Configurações de embalagem — `product_packaging_configs`, Conversões — `item_unit_conversions`

- Ambas versionadas por produto (`UNIQUE (product_id|item_id, version)`) e congeladas em OP, reserva, saída de acabado e item de pedido.
- **Alvo**: consultar todas as versões, mostrar qual está vigente, duplicar a configuração como nova versão e excluir somente versão nunca usada em `production_orders`, `stock_reservations`, `batch_finished_outputs` e `order_items`.

### Usuários — `profiles` + Supabase Auth

- **Campos**: `display_name`, `role` (ADMINISTRADOR, VENDAS, PRODUCAO), `active`, `can_approve_recipe`, `can_release_lot`, `profile_version`.
- Referenciado por mais de 40 FKs de autoria e auditoria (`audit_logs.actor` com `RESTRICT`). Exclusão definitiva nunca é oferecida.
- **RPCs**: `manage_profile` (com proteção do último administrador e sem autoelevação) e `link_auth_profile`.
- **Falta**: convite, reenvio, revogação de convite e recuperação de senha. Exigem uma Edge Function com a chave secreta guardada como segredo do Supabase, nunca no front.
- **Situação**: BLOQUEADO até a Edge Function ser publicada e testada em homologação.

### Valores estruturais mantidos fixos

Classificação de item, unidade (kg, g, L, mL, un), etapas de receita (`PREPARACAO`, `BATER_MASSA`), perfis, situação de lote e etapas do Kanban são `CHECK`s usados pelas regras de negócio e pelas RPCs. Não viram cadastro editável. Mudar esses valores exige migration e revisão das RPCs.

## Desenho da Fase B (backend)

Uma migration incremental (`20261127001000_catalog_lifecycle.sql`), aplicada primeiro em homologação:

1. `catalog_dependencies(entity text, record_id uuid)` faz a prévia.
   - Devolve `can_delete`, `can_deactivate`, `reasons[]`, `dependencies[{type,label,count}]` e `record_version`.
   - Aceita só uma lista fixa de entidades: CLIENTE, PRODUTO, INSUMO, FORNECEDOR, FABRICANTE, LOCAL, MOTIVO_PERDA, DESTINACAO_PERDA, VERSAO_RECEITA, CONFIG_EMBALAGEM.
   - Não aceita nome de tabela vindo do front.
2. `delete_catalog_record(entity, record_id, expected_version, reason, request_id)` exclui.
   - Trava a linha com `FOR UPDATE` e recalcula as dependências na mesma transação.
   - Exclui só se não houver nenhuma e grava `audit_logs` com um retrato mínimo do registro.
   - É idempotente via `claim_operation`.
3. `set_catalog_active(entity, record_id, expected_version, active, reason, request_id)` inativa e reativa com as regras por entidade descritas acima.
4. `catalog_history(entity, record_id)` lê `audit_logs` filtrado pela entidade e pelo registro, só para Administração.
5. `save_item` inclui e edita produtos, com duplicidade de código e descrição verificada no servidor. `duplicate_item` fica no front, que pré-preenche o formulário de novo produto.
6. Versões em `loss_reasons` e `loss_destinations`, para controle de concorrência.

Todas seguem o padrão existente: wrapper `security invoker` em `public` sobre `security definer` em `purezza_private`, `search_path=''`, permissões revogadas de `anon`, verificação de papel em cada função e `request_id` obrigatório. Nenhuma RPC executa SQL vindo do front.

## Testes previstos

Testes PGlite novos em `tests/catalogLifecycle.test.ts`. Para cada entidade, cobrem:

- exclusão elegível;
- bloqueio com dependência;
- dependência criada entre a prévia e a confirmação;
- versão desatualizada;
- reenvio idempotente;
- perfil sem permissão;
- inativação bloqueada com saldo ou pedido aberto;
- reativação com nome duplicado.

Depois vem a validação SQL autenticada em homologação e o E2E com os 3 perfis.
