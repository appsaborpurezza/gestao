# Sabor Purezza SMART

Inclui a base da fase 1 e o primeiro incremento de estoque da fase 2. A aplicação oferece autenticação por e-mail, consulta do catálogo e das receitas preliminares, importação com prévia, recebimento em quarentena, consulta de saldos por lote, decisões sanitárias e sugestão FEFO. As migrations foram testadas num PostgreSQL descartável.

## Desenvolvimento local

Use Node.js 24 e pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build
```

Abra a URL exibida pelo Vite com o caminho `/gestao/`. Copie `.env.example` para `.env.local` e ajuste URL e chave publicável ao usar um projeto de homologação. Por padrão, o frontend aponta para o projeto indicado no pedido. A chave publicável pode aparecer no bundle. O acesso aos dados depende do perfil ativo no Supabase.

## Estrutura do banco

| Migração | Estruturas |
| --- | --- |
| `20261124000100_foundation.sql` | `profiles`, `items`, `recipes`, `recipe_versions`, `recipe_ingredients`, `audit_logs`, perfis e políticas de leitura |
| `20261124000200_preliminary_import.sql` | RPC administrativa de importação e função privilegiada em schema privado |
| `20261124000300_receiving_stock.sql` | Fornecedores, fabricantes, locais, recebimentos, lotes, saldos, ledger, decisões, idempotência e RPCs de estoque |
| `20261124000400_stock_transfers.sql` | Transferência atômica entre locais, com duas pernas vinculadas no ledger |
| `20261124000500_stock_counts.sql` | Contagens por lote e local, revisão administrativa e ajuste auditado |
| `20261124000600_opening_inventory.sql` | Origem de inventário inicial, entrada auditada e regras de liberação |
| `20261124000700_inventory_labels.sql` | Dados para etiquetas internas e auditoria de solicitações de impressão |
| `20261124000800_stock_position.sql` | Posição histórica por lote e local, com filtros e paginação no banco |
| `20261124000900_stock_position_export.sql` | Exportação integral da posição filtrada em uma consulta autenticada |
| `20261124001000_inventory_sessions.sql` | Sessões locais de inventário, contagens vinculadas e encerramento administrativo |
| `20261124001100_customers.sql` | Cadastro comercial protegido, validação de CPF/CNPJ e auditoria de alterações |
| `20261124001200_order_drafts.sql` | Pedidos em rascunho, itens, dados financeiros separados e cálculo atômico em BRL |
| `20261124001300_order_draft_edits.sql` | Edição transacional de rascunhos com controle de versão |
| `20261124001400_order_confirmation.sql` | Confirmação auditada e fila operacional de demanda de fabricação própria |
| `20261124001500_production_plan_simulation.sql` | Simulação de massadas, faixa de rendimento e ingredientes previstos |
| `20261124001600_item_weight_conversions.sql` | Configuração auditada de unidade base, fatores versionados e resolução de demandas pendentes |
| `20261124001700_external_billing.sql` | Registro de faturamento externo, parcelas e conciliação do saldo a faturar |
| `20261124001800_commercial_documents.sql` | Configuração da empresa, dados congelados do PDF comercial e auditoria de emissão |
| `20261124001900_stock_reservations.sql` | Reservas de itens de terceiros e revenda, FEFO líquido e proteção do saldo reservado |
| `20261124002000_reserved_shipments.sql` | Fila de expedição, despacho por reserva e baixa vinculada ao lote |
| `20261124002100_shipment_delivery.sql` | Histórico paginado de expedições e confirmação de entrega ou retirada |
| `20261124002200_shipment_returns.sql` | Devolução rastreada ao despacho, lote separado e entrada em quarentena |
| `20261124002300_lot_traceability.sql` | Consulta de origem, devoluções, destinos e movimentações por código interno de lote |
| `20261124002400_operational_catalogs.sql` | Cadastros administrativos auditados de fornecedores, fabricantes, locais e insumos |
| `20261124002500_recipe_review.sql` | Ficha técnica em revisão, com ingredientes vinculados a insumos e transcrição original preservada |
| `20261124002600_recipe_approval.sql` | Aprovação restrita, proteção da ficha aprovada e simulação com parâmetros aprovados |
| `20261124002700_recipe_assignments.sql` | Associação versionada de receita aprovada ao produto e cliente, com padrão explícito |
| `20261124002800_production_orders.sql` | Ordem de produção planejada, ficha congelada e massadas numeradas por OP |
| `20261124002900_batch_start.sql` | Início individual da preparação, lote sequencial por dia e consulta do quadro |
| `20261124003000_preparation_consumption.sql` | Pesagem por ingrediente da preparação e baixa FEFO vinculada à massada |
| `20261124003100_batch_water_handoff.sql` | Água de processo, passagem para Bater massa e incorporação sem baixa duplicada |
| `20261124003200_mixing_rolling.sql` | Conclusão de Bater massa e Cilindros com medição opcional e passagem para Embalagem |
| `20261124003300_packaging_and_output.sql` | Configuração de embalagem, consumo por lote e entrada de produto acabado em quarentena |
| `20261124003400_finished_stock_reservations.sql` | Reservas de acabados próprios compatíveis e cálculo da cobertura real da demanda |
| `20261124003500_production_genealogy.sql` | Vínculos entre lotes de insumos, massadas, acabados e destinos |
| `20261124003600_lot_recall.sql` | Recolhimento por lote, bloqueio dos derivados, destinos e registro de ações |
| `20261124003700_recall_disposition.sql` | Encerramento sanitário, decisão independente de liberação e autorização de retomada |
| `20261124003800_stage_pauses.sql` | Pausas, retomadas, histórico e tempo produtivo por etapa |
| `20261124003900_mass_losses.sql` | Registro de desperdício de massa, conciliação e histórico por período e causa |
| `20261124004000_stock_waste.sql` | Descarte por lote e local com baixa física e histórico por categoria e unidade |
| `20261124004100_role_dashboard.sql` | Indicadores por período e por perfil, calculados dos registros operacionais |

O painel **Indicadores** usa o fuso de São Paulo e abre no mês corrente. Administração vê os indicadores operacionais e comerciais, Produção vê os operacionais e Vendas vê os comerciais. A cobertura de pesagem aparece junto dos pesos, e valores sem base de cálculo aparecem como **N/D**. O percentual de perda divide a perda vinculada pelo peso medido mais essa perda, considerando as massadas finalizadas e as perdas registradas no período. A validade usa o saldo atual. O OTIF usa comprovantes de entrega registrados até o fim da data prevista, com cobertura integral de todos os itens. O faturamento usa os registros pela data de emissão.

As políticas permitem a leitura técnica a Administração e Produção. Vendas consulta o catálogo comercial ativo. O cliente web não tem permissão de escrita direta. A importação associa versões e ingredientes a registros relacionais, preserva a ordem e mantém campos desconhecidos nulos. O perfil ADMINISTRADOR não recebe permissões técnicas específicas por padrão.

Em **Indicadores**, consulte o período e use **Exportar PDF** ou **Exportar Excel**. Os arquivos incluem o período efetivamente consultado, a data de emissão em São Paulo e as seções autorizadas para o perfil. O Excel mantém as contagens como números e conserva os valores com unidade e a indicação N/D como texto.

O Pareto ordena os motivos de perda por kg registrado, mostra a participação no total e calcula o percentual acumulado a partir dos pesos. A série de produção e perdas pode ser agrupada por dia, semana (a partir de segunda-feira) ou mês. O agrupamento usa somente os dias do período consultado. O PDF e o Excel incluem a série no agrupamento selecionado e o Pareto quando há perdas.

Na visão semanal ou mensal, use **Ver dias** na linha do período para conferir os registros diários que compõem o total. Nessas duas visões, o PDF e o Excel incluem também a série diária completa da consulta. A sessão da aba lembra o último período consultado e o agrupamento por conta e perfil. Os atalhos consultam hoje, ontem, esta semana, semana anterior, este mês, mês anterior ou este ano. As semanas começam na segunda-feira, e as datas são calculadas no calendário de São Paulo.

Na série de produção e perdas, as barras de peso medido e perda registrada compartilham uma escala ajustada à maior quantidade do agrupamento em exibição. Os valores exatos permanecem na tabela.

## Configuração do primeiro administrador

1. Teste as migrations em um projeto Supabase separado. Antes de aplicar no projeto alvo, registre um backup e confirme a restauração em ambiente isolado.
2. Em Auth, desative o cadastro público. Configure a URL do site e os redirecionamentos autorizados para recuperação de senha.
3. Convide `app.saborpurezza@gmail.com` pelo painel Auth, com o fluxo administrativo do Supabase. Confirme o endereço e copie o UUID do usuário no painel. Se o convite exigir configuração adicional de SMTP ou de redirecionamento, valide o fluxo em homologação.
4. No SQL Editor, associe o UUID confirmado ao perfil. A consulta exige correspondência de UUID e e-mail e preserva perfis existentes. Confira a linha retornada.

```sql
insert into public.profiles (id, display_name, role)
select id, 'Administração', 'ADMINISTRADOR'
from auth.users
where id = '<UUID confirmado>'::uuid
  and lower(email) = 'app.saborpurezza@gmail.com'
on conflict (id) do nothing
returning id, role, active;
```

5. Entre como administrador e abra **Importação**. Selecione os anexos originais, revise a lista e confirme. O resultado informa registros inseridos e registros existentes. Guarde os anexos em local privado, fora do repositório e da hospedagem.

## Verificação e homologação

A suíte executa as migrations em PGlite com papéis e identidade de teste. Para testar a carga real, aponte a variável `PUREZZA_IMPORT_DIR` para a pasta privada que contém os dois anexos e rode `pnpm test`. A carga é revertida no banco de teste. A CI utiliza apenas casos fictícios.

O PGlite cobre constraints, RLS, permissões SQL, rollback, reimportação e as regras de recebimento e FEFO. Auth, PostgREST, convites, SMTP e recuperação de senha precisam de verificação em um projeto Supabase de homologação. A aprovação de receitas e o início de produção permanecem indisponíveis neste incremento.

## Habilitar recebimento em homologação

Em **Cadastros operacionais**, a Administração pode registrar ou editar fornecedores, fabricantes, locais e insumos. Use dados homologados pela empresa. O sistema bloqueia a desativação de um local que tenha saldo físico ou sessão de inventário aberta. Cadastros de insumos preservam o código e a descrição originais e exibem a descrição atual. As telas de rastreabilidade e posição consultam os nomes e códigos atuais de fornecedores, fabricantes e locais.

Conceda `profiles.can_release_lot` apenas ao administrador ativo designado pela empresa, pelo UUID confirmado. Defina a unidade de cada SKU em **Produtos → Configurar unidade** somente após validá-la com a empresa.

Em **Estoque → Registrar recebimento**, Administração e Produção registram um lote por operação na unidade base. O lote entra em quarentena e o movimento físico é registrado na mesma transação. Em **Lotes e FEFO**, a decisão de liberação exige a permissão sanitária e o motivo. Lotes com validade desconhecida, vencidos ou sem NF permanecem inelegíveis. Lotes sem validade aplicável exigem justificativa e são ordenados por recebimento depois dos lotes com validade informada.

Até homologar a regra do último dia utilizável, a consulta e a liberação exigem validade posterior à data corrente em São Paulo. A sugestão FEFO pode cobrir apenas parte da quantidade pedida. Ela não reserva saldo.

Em **Estoque → Lotes e FEFO → Transferir saldo**, Administração e Produção podem mover saldo físico entre locais ativos. O lote mantém identidade, validade e status sanitário. A quantidade global permanece igual e o ledger registra o débito e o crédito com o mesmo identificador.

Em **Estoque → Lotes e FEFO → Registrar contagem**, Administração e Produção podem registrar a quantidade física de um lote já cadastrado. A Administração revisa a contagem na ficha do lote. Uma aprovação registra somente a diferença. Se houver movimentação posterior no local, registre uma nova contagem. O ajuste conserva o status sanitário do lote.

Em **Estoque → Inventário inicial**, a Administração registra lotes que já estão fisicamente na empresa. Informe o fabricante e o lote de origem verificáveis, a localização e a quantidade observada. A referência da contagem registra a origem do inventário. O saldo nasce quando a contagem é aprovada na ficha do lote. O lote continua em quarentena até a liberação sanitária, que exige documento de origem e validade elegível. A abertura não cria recebimento nem fornecedor fictício.

Em **Estoque → Lotes e FEFO → Imprimir etiqueta interna**, Administração e Produção podem solicitar uma etiqueta após o registro da entrada inicial. A etiqueta informa a quantidade e o local iniciais, mesmo após transferências. O QR contém somente o código interno do lote. A auditoria registra a solicitação antes de abrir a caixa de impressão. A impressão física pode ser cancelada no navegador.

Em **Estoque → Lotes e FEFO → Localizar lote**, digite o código interno ou use um leitor USB com o foco nesse campo. Em dispositivos com câmera, **Ler QR com a câmera** solicita acesso e encerra a captura após a leitura de um código válido. A decodificação ocorre no navegador. Apenas o código é enviado para a consulta autenticada. O fluxo de câmera exige HTTPS, salvo origens locais consideradas seguras pelo navegador.

Em **Estoque → Posição por data**, Administração e Produção podem consultar o saldo físico por lote e local, filtrando por item e endereço. O saldo soma as movimentações registradas até o fim da data selecionada em São Paulo e a consulta é paginada no banco. A data atual mostra as movimentações registradas até o momento da consulta. Descrições e códigos de localização vêm do cadastro atual. Linhas com saldo zero ficam fora do relatório.

Depois de consultar a posição, **Exportar Excel** e **Exportar PDF** consultam todas as posições dos filtros aplicados, em uma única leitura do banco. Os arquivos indicam data da posição, filtros e horário de emissão em São Paulo. O Excel guarda como texto as quantidades que ultrapassam sua precisão numérica de 15 dígitos significativos. A exportação é montada no navegador e usa memória proporcional ao número de linhas.

Em **Estoque → Sessões de inventário**, Administração e Produção podem abrir uma sessão por local e agrupar as contagens. O código interno do lote pode ser digitado ou preenchido com leitor USB. A Administração revisa cada contagem e encerra a sessão quando não houver revisão pendente. Um lote pode ser recontado na mesma sessão se a contagem anterior tiver sido rejeitada. A tela lista as sessões abertas e as 20 encerradas mais recentes.

O estoque ainda precisa de anexos fiscais, tratamento documental e testes E2E. A impressão e a leitura precisam ser homologadas na impressora, no papel, nos leitores USB e nos dispositivos usados pela empresa. Restauração de backup e GitHub Pages continuam pendentes.

## Revisão técnica de receitas

Em **Receitas → Abrir ficha técnica**, a Administração pode registrar os dados já conferidos e salvar a ficha mesmo quando ainda houver campos pendentes. A Produção pode consultar a ficha. Insumos vinculados devem estar ativos e usar uma unidade compatível. As quantidades e o rendimento da transcrição original continuam preservados.

O responsável técnico designado aprova a ficha salva em **Aprovação técnica**, com referência formal. Conceda `profiles.can_approve_recipe` somente ao responsável designado e ativo, pelo UUID confirmado. A aprovação exige os dados de rendimento, validade, armazenamento, controle da água, etapas, quantidades, tolerâncias e referências técnicas aplicáveis. A ficha aprovada é imutável, e o simulador passa a usar seus valores revisados.

Em **Associações de receitas**, a Administração pode configurar uma versão aprovada para um produto e cliente ou autorizar uma versão padrão do produto. A regra do cliente tem prioridade. Encerrar uma regra específica permite a aplicação da regra padrão se ela existir. Substituições ou encerramentos preservam o histórico. A criação de uma nova versão da receita ainda precisa ser implementada.

## Cadastro comercial

Em **Clientes**, Administração e Vendas podem cadastrar ou editar pessoas físicas e jurídicas, pesquisar por nome ou razão social e desativar cadastros. O banco normaliza CPF, CNPJ, CEP e UF. O CPF e os formatos numérico e alfanumérico do CNPJ têm dígitos verificadores conferidos localmente. A validação não consulta a situação cadastral na Receita Federal. O banco impede duplicidade de documento informado e sobrescrita de versões desatualizadas. Produção ainda não tem uma tela operacional de clientes vinculada a pedidos.

Em **Pedidos → Novo rascunho**, Administração e Vendas podem cadastrar pedidos para clientes ativos. Cada item usa a unidade base cadastrada. O banco calcula o total por linha com arredondamento em centavos e desconto em valor, e registra o total do pedido. Observações comerciais e operacionais ficam separadas. O rascunho não altera o estoque.

Em **Produtos → Configurar unidade**, a Administração pode registrar o fator validado em kg para unidades, litros ou mililitros, com justificativa. As unidades de massa têm fatores fixos. A alteração do fator conserva o histórico e o peso já registrado no pedido. Em **Demanda de produção**, a ação **Aplicar conversão cadastrada** só atualiza uma demanda que ainda não tinha peso em kg. A unidade base fica protegida contra alterações quando já vinculada a lotes ou pedidos confirmados.

Em **Pedidos → Abrir → Editar rascunho**, Administração e Vendas podem alterar cliente, itens, preços, descontos e condições. O número, o vendedor original e a data de emissão são preservados. Se outra pessoa alterar o pedido antes de você salvar, reabra o rascunho para consultar a versão atual. Se a unidade base de um item mudou, informe quantidade e preço na nova unidade.

Em **Pedidos → Abrir → Revisar para confirmar**, Administração e Vendas confirmam um rascunho com cliente ativo, data de entrega e itens elegíveis. A confirmação fecha a edição do rascunho. A tela **Demanda de produção** mostra à Administração e à Produção somente os itens classificados como fabricação própria, ordenados por prazo. Produtos sem conversão para kg aparecem com conversão pendente. A confirmação não cria OP nem movimenta ou reserva estoque.

Em **Demanda de produção → Simular**, Administração e Produção podem comparar rendimento médio ou conservador para uma demanda com peso conhecido. Quando existe associação vigente, a tela sugere a versão aprovada correspondente. A seleção manual permite simular outras versões, inclusive pendentes. O cálculo mostra necessidade líquida, massadas inteiras, faixa de produção, risco de falta, excedente teórico e ingredientes conhecidos. A quantidade de farinha é apresentada também em sacos equivalentes de 25 kg. O estoque informado é apenas uma hipótese da simulação.

Para **Abrir ordem de produção**, selecione a cobertura real, simule a receita aprovada associada à demanda e justifique a escolha do rendimento. O servidor revalida a regra, desconta os acabados compatíveis reservados ou já despachados, guarda os parâmetros técnicos e gera uma OP com até 1.000 massadas planejadas. Demandas integralmente cobertas não geram OP. Há uma OP por demanda neste incremento. A abertura não inicia produção, não atribui lote e não movimenta estoque.

No **Quadro de produção**, Administração e Produção podem iniciar a preparação de uma massada planejada. O início exige a ficha aprovada e saldo elegível dos insumos da ficha, com a água tratada pela referência de controle registrada. A operação atribui o lote `SP-AAAAMMDD-NNNN` e registra o operador. A conferência de saldo no início não reserva nem consome estoque. Vendas acompanha o quadro sem acesso à fórmula ou ao operador. A tela atualiza por consulta periódica a cada 15 segundos.

Na massada em preparação, abra **Apontar preparação**, informe o peso efetivo na unidade da ficha e confira os lotes sugeridos. A baixa é registrada somente após confirmação. O servidor confere a tolerância, revalida o FEFO e registra cada quantidade por lote e local. Se o estoque mudar e a sugestão deixar de corresponder, consulte os lotes novamente.

A água de processo é registrada na etapa prevista, com quantidade medida, origem e referência do controle, sem baixa de estoque. Conclua todos os apontamentos da preparação para avançar a **Bater massa**. A etapa seguinte mostra o que foi separado e permite confirmar a incorporação sem nova baixa. Ingredientes adicionais de **Bater massa** são baixados pelo mesmo fluxo FEFO.

Após a incorporação e os apontamentos de **Bater massa**, conclua a etapa para iniciar **Cilindros**. A conclusão de **Cilindros** inicia **Embalagem**. Informe o peso apenas se tiver sido medido. As duas transições registram operador, horários e observações.

Em uma massada ativa no quadro, Administração e Produção podem **Pausar etapa** com motivo e **Retomar etapa** quando o trabalho reiniciar. O banco registra os horários e operadores, bloqueia consumos, medições e conclusão enquanto pausada, e calcula tempo produtivo descontando os intervalos. O **Histórico de tempos** mostra as pausas de cada etapa. Correções de horário ainda não estão disponíveis.

Para finalizar uma massada, configure o SKU próprio em unidade `un`, com fator aprovado em kg, fabricante do acabado, embalagem e etiqueta cadastradas como insumos em `un`. Em **Produtos → Configurar unidade → Configurar embalagem e etiqueta**, informe o consumo aprovado por unidade. A OP guarda a configuração vigente na abertura, ou a primeira usada na finalização se nenhuma tiver sido cadastrada naquele momento.

No **Quadro de produção → Apontar embalagem**, informe unidades conformes, materiais rejeitados, local e medição, quando necessária. A operação usa a medição registrada de cilindros ou de mistura se não houver uma nova medição. Revalida o FEFO e grava as baixas de embalagem e etiqueta junto com a entrada do acabado em quarentena, na mesma transação. A fabricação usa a data de início da massada em São Paulo. A data de vencimento usa essa data mais o prazo em dias da ficha aprovada. Este incremento gera um único SKU por massada. Múltiplas apresentações, correções de pesagem e exceções FEFO continuam pendentes.

## Desperdícios

Use **Apontar perda de massa** na etapa em execução ou **Desperdícios → Registrar perda sem massada**. Ambos gravam no mesmo histórico, sem gerar nova baixa de estoque. A Administração com autorização sanitária específica precisa cadastrar as destinações realmente aprovadas antes do lançamento. O histórico mostra o total filtrado por período e causa, em São Paulo. A Administração pode conciliar uma perda já registrada com uma massada e etapa compatíveis. A conciliação atualiza o vínculo no registro existente e preserva o total. A rastreabilidade exibe as perdas vinculadas.

Em **Estoque → Lotes e FEFO → Descartar saldo físico**, a Administração pode registrar perdas de insumos, embalagens e acabados. Descarte de devoluções ou lotes vinculados a recolhimento exige permissão sanitária específica. Informe o local, a quantidade descartada na unidade do lote, o motivo e a destinação aprovada. O sistema impede baixa de saldo reservado e grava o movimento e o descarte na mesma transação. Em **Desperdícios → Descartes de estoque**, Administração e Produção consultam os totais por categoria e unidade.

## Faturamento, expedição e rastreabilidade

Em **Pedidos → Abrir → Faturamento externo**, Vendas pode registrar a referência da nota já emitida externamente, o valor atribuído ao pedido e as parcelas. A soma das parcelas deve corresponder ao valor informado, que não pode superar o saldo a faturar. Administração pode consultar os registros. O faturamento não altera o andamento operacional nem indica recebimento de pagamento.

Após o faturamento integral, Vendas pode usar **Pedidos → Abrir → Baixar PDF comercial**. Cada folha A4 traz o mesmo trecho nas vias Cliente e Empresa, com linha de corte. Pedidos extensos são paginados, com as duas vias identificadas em cada folha. A Administração pode alterar os dados da empresa em **Pedidos → Dados do PDF comercial**. Esses dados começam com o endereço e telefone fornecidos na especificação e valem apenas para emissões novas.

O servidor guarda os dados congelados, o hash, a versão do gerador, o emissor e o horário da primeira emissão. O navegador gera o PDF com esses dados. A reemissão requer a mesma versão do gerador e o mesmo arquivo de logo. O arquivo binário ainda não é arquivado no Supabase e o fluxo de retificação ainda não foi implementado. A impressão física A4 precisa de homologação.

Nos itens de pedidos confirmados, a Administração pode usar **Gerenciar reservas → Reservar por FEFO**. A quantidade solicitada pode ser distribuída entre lotes. A reserva exige validade posterior ao dia da entrega ou, quando aplicável, justificativa registrada de validade não aplicável. O saldo físico permanece igual. Transferências e ajustes respeitam a quantidade reservada. A Administração pode liberar a reserva com justificativa e a tela indica quando o lote ou local deixou de atender aos critérios.

Para fabricação própria, o lote também precisa ter saída de massada finalizada, receita e versão compatíveis, mesma configuração de embalagem e mesmo peso nominal por unidade. Lotes produzidos para cliente específico só atendem esse cliente. A expedição revalida a compatibilidade antes da baixa.

Em **Expedição**, Administração e Produção podem confirmar o despacho de uma quantidade de uma reserva por operação, em entrega ou retirada. O sistema revalida o lote e o local antes da baixa, mantém o restante reservado e registra pedido, lote, local, operador e movimento. O pedido fica **Parcial** até que toda a quantidade seja despachada, quando passa a **Expedido**. O faturamento e a emissão do PDF comercial continuam disponíveis após o despacho.

Em **Expedição → Histórico**, Administração e Produção podem confirmar a entrega ou retirada de cada despacho. Informe data e hora reais de São Paulo ou deixe o campo em branco para usar o horário do servidor. A confirmação registra o horário, o operador e a referência opcional do comprovante. Vendas pode consultar o histórico e o filtro de pendências.

Em **Expedição → Histórico → Registrar devolução**, Administração e Produção podem receber até a quantidade ainda devolvível do despacho. Selecione o local físico de quarentena e informe o motivo. A devolução cria um lote interno com a origem e a validade do lote despachado. O produto fica fora do saldo elegível. A devolução preserva o despacho original e não reabre o pedido.

Em **Rastreabilidade**, Administração e Produção podem digitar ou escanear o código interno de um lote para consultar a origem, os lotes de devolução relacionados, o saldo físico e reservado, as movimentações, as decisões sanitárias e os destinos despachados. A consulta por um lote devolvido também mostra o lote original e sua origem. Vendas acompanha os destinos e devoluções pelo histórico de expedição.

Para fabricação própria, a consulta do acabado mostra a OP, a massada, a versão da receita, os lotes de ingredientes, embalagens e etiquetas e os registros da água de processo. A consulta de um insumo mostra as massadas em que foi usado, os acabados gerados e as quantidades despachadas por cliente. Os códigos permitem abrir a consulta dos lotes relacionados.

Em **Recolhimentos**, a Administração pode abrir um caso com o código interno de origem e o motivo. O sistema bloqueia o lote e os derivados identificados, impede avanço das massadas afetadas, mantém reservas sinalizadas como inelegíveis e lista os despachos e clientes afetados. Administração e Produção registram ações e contatos já realizados. Devoluções novas de lotes afetados são anexadas ao caso em quarentena.

A Administração com permissão sanitária específica pode encerrar o recolhimento após registrar a avaliação. O encerramento conserva o bloqueio dos lotes. Uma liberação posterior exige decisão sanitária em **Estoque** e ausência de outros casos ativos sobre o lote. A retomada de uma massada exige o encerramento de todos os casos ativos que a afetam e autorização registrada em cada caso. Os registros de abertura, avaliação, bloqueio e retomada ficam no histórico.

Unidades comerciais alternativas, avaliação sanitária de devoluções para eventual reaproveitamento, exportação da rastreabilidade, tratamento de pedidos confirmados, múltiplas apresentações por massada e cancelamento fiscal continuam pendentes.
## Modernização V2

A [matriz de conclusão da V2](docs/V2_STATUS.md) acompanha os 31 tópicos originais, suas evidências e as pendências de homologação e publicação.

A branch `feat/v2-modernizacao` parte da referência local `474767a`. O primeiro incremento reorganiza os módulos em uma barra lateral recolhível, com menu em diálogo para telas menores. Use **Buscar módulos** ou **Ctrl+K** para localizar uma tela autorizada. A busca deste incremento abrange nomes de módulos.

O Supabase de produção foi conferido antes da alteração de interface. Foram constatadas 41 migrations, 54 tabelas públicas com RLS, 37 produtos e nove versões de receita. O ambiente Supabase de homologação já existente é `vooyoomskkaivlluioeq`.

A busca por **Ctrl+K** consulta produtos, clientes, pedidos e receitas pela RPC `workspace_search`, além dos módulos disponíveis. Os resultados paginados abrem o registro encontrado. A busca respeita as permissões existentes, não retorna valores comerciais e mantém os termos apenas na memória durante a consulta.

O login usa o logotipo original e reorganiza o formulário para telas estreitas. As páginas compartilham os estilos de controles, tabelas, foco e painéis. No Kanban, os estados das massadas têm rótulos visíveis e cores correspondentes. Essa atualização é de interface e não requer migrations.

Em **Principal → Central de alertas**, consulte os grupos ativos por severidade com base no dia de São Paulo. Cada grupo abre o módulo correspondente. A **Central de relatórios** reúne os atalhos autorizados para as consultas e exportações já existentes.

Em **Administração → Usuários e permissões**, administradores podem vincular contas confirmadas no Supabase Auth e revisar ou alterar perfis existentes. O backend registra as mudanças em auditoria, verifica a versão editada e protege o último administrador ativo. As permissões de aprovar receitas e liberar lotes são independentes. Convites e recuperação ainda usam o Supabase Auth.

O Kanban V2 usa a migration incremental `20261127000100_production_board_columns.sql`. A consulta retorna as seis etapas com totais filtrados e paginação própria. A busca abrange número da OP, pedido, cliente, produto e lote, ignora acentos e cancela requisições obsoletas.

As migrations `20261127000200_production_board_realtime.sql` e `20261127000300_production_board_revision.sql` instalam os gatilhos e publicam somente a revisão do quadro via Postgres Changes. A tabela de revisão exige perfil ativo via RLS. O cliente agrupa sinais próximos, consulta somente o quadro ativo e mantém os filtros e a paginação. Quando o canal está indisponível, o quadro consulta a cada 60 segundos com a aba visível. Em **Gestão à vista**, Produção e Administração podem consultar as seis etapas sem ações de edição. Faça backup antes de aplicar as migrations V2 em produção. Para reverter a interface, publique a versão anterior do frontend, que continua usando a RPC original.
