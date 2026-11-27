import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { previewImport } from '../src/features/import/schema'

const db = new PGlite()
const migration = (name: string) => readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8')
const admin = '00000000-0000-4000-8000-000000000001'
const sales = '00000000-0000-4000-8000-000000000002'
const production = '00000000-0000-4000-8000-000000000003'
const inactive = '00000000-0000-4000-8000-000000000004'

const products = [{ codigo_original: '1', descricao_original: 'Produto de teste ', classificacao_preliminar: 'TERCEIRO', status_validacao: 'PENDENTE_VALIDACAO' }]
const formulas = [{
  codigo: 'TESTE', nome: 'Receita fictícia', versao: 1, status: 'PENDENTE_VALIDACAO',
  rendimento_kg: { minimo: 133, medio: 134, maximo: 135 },
  ingredientes: [{ nome: 'Água', quantidade: null, unidade: 'L', etapa: null, tolerancia: null }],
}]

beforeAll(async () => {
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean not null default false);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
  `)
  for (const name of [
    '20261124000100_foundation.sql', '20261124000200_preliminary_import.sql',
    '20261124000300_receiving_stock.sql', '20261124000400_stock_transfers.sql',
    '20261124000500_stock_counts.sql',
    '20261124000600_opening_inventory.sql',
    '20261124000700_inventory_labels.sql',
    '20261124000800_stock_position.sql',
    '20261124000900_stock_position_export.sql',
    '20261124001000_inventory_sessions.sql',
    '20261124001100_customers.sql',
    '20261124001200_order_drafts.sql',
    '20261124001300_order_draft_edits.sql',
    '20261124001400_order_confirmation.sql',
    '20261124001500_production_plan_simulation.sql',
    '20261124001600_item_weight_conversions.sql',
    '20261124001700_external_billing.sql',
    '20261124001800_commercial_documents.sql',
    '20261124001900_stock_reservations.sql',
    '20261124002000_reserved_shipments.sql',
    '20261124002100_shipment_delivery.sql',
    '20261124002200_shipment_returns.sql',
    '20261124002300_lot_traceability.sql',
    '20261124002400_operational_catalogs.sql',
    '20261124002500_recipe_review.sql',
    '20261124002600_recipe_approval.sql',
    '20261124002700_recipe_assignments.sql',
    '20261124002800_production_orders.sql',
    '20261124002900_batch_start.sql',
    '20261124003000_preparation_consumption.sql',
    '20261124003100_batch_water_handoff.sql',
    '20261124003200_mixing_rolling.sql',
    '20261124003300_packaging_and_output.sql',
    '20261124003400_finished_stock_reservations.sql',
    '20261124003500_production_genealogy.sql',
    '20261124003600_lot_recall.sql',
    '20261124003700_recall_disposition.sql',
    '20261124003800_stage_pauses.sql',
    '20261124003900_mass_losses.sql',
    '20261124004000_stock_waste.sql',
    '20261124004100_role_dashboard.sql',
    '20261127000100_production_board_columns.sql',
    '20261127000200_production_board_realtime.sql',
    '20261127000300_production_board_revision.sql',
    '20261127000400_workspace_search.sql',
    '20261127000500_operational_alerts.sql',
    '20261127000600_manage_profiles.sql',
  ]) {
    await db.exec(await migration(name))
  }
  for (const [id, role, active] of [
    [admin, 'ADMINISTRADOR', true], [sales, 'VENDAS', true], [production, 'PRODUCAO', true], [inactive, 'ADMINISTRADOR', false],
  ]) {
    await db.query('insert into auth.users(id) values ($1)', [id])
    await db.query('insert into public.profiles(id, display_name, role, active) values ($1, $2, $3, $4)', [id, role, role, active])
  }
}, 30_000)

afterAll(async () => db.close())

async function asUser(id: string) {
  await db.exec('set role authenticated')
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id])
}

function importRecords(items = products, recipes = formulas) {
  return db.query<{ result: Record<string, number> }>('select public.import_preliminary($1, $2) result', [
    JSON.stringify(items), JSON.stringify(recipes),
  ])
}

test('importa uma vez, preserva descrição e mantém água e receita pendentes', async () => {
  await asUser(admin)
  const first = await importRecords()
  expect(first.rows[0]?.result).toEqual({ produtos_inseridos: 1, produtos_existentes: 0, versoes_inseridas: 1, versoes_existentes: 0 })
  const again = await importRecords([{ ...products[0]!, descricao_original: 'Alterada' }])
  expect(again.rows[0]?.result).toEqual({ produtos_inseridos: 0, produtos_existentes: 1, versoes_inseridas: 0, versoes_existentes: 1 })
  expect((await db.query('select original_description from public.items')).rows).toEqual([{ original_description: 'Produto de teste ' }])
  expect((await db.query('select quantity from public.recipe_ingredients')).rows).toEqual([{ quantity: null }])
  expect((await db.query('select status from public.recipe_versions')).rows).toEqual([{ status: 'PENDENTE_VALIDACAO' }])
  expect((await db.query('select id from public.audit_logs')).rows).toHaveLength(1)
})

test('busca global ignora acentos, pagina e respeita o acesso às receitas', async () => {
  const search = (term: string, offset = 0) => db.query('select module,reference from public.workspace_search($1,$2)', [term, offset])
  await asUser(admin)
  expect((await search('PRÓDUTO DE TESTE')).rows).toEqual([{ module: 'products', reference: '1' }])
  expect((await search('PRÓDUTO DE TESTE', 1)).rows).toEqual([])
  expect((await search('receita ficticia')).rows).toEqual([{ module: 'recipes', reference: 'TESTE' }])
  await asUser(sales)
  expect((await search('receita ficticia')).rows).toEqual([])
  await asUser(inactive)
  await expect(search('teste')).rejects.toThrow('perfil')
})

test('alertas operacionais respeitam o perfil e omitem grupos sem ocorrências', async () => {
  const alerts = () => db.query('select code,quantity::int from public.operational_alerts()')
  await asUser(production)
  expect((await alerts()).rows).toEqual([{ code: 'RECIPES_PENDING', quantity: 1 }])
  await asUser(sales)
  expect((await alerts()).rows).toEqual([])
  await asUser(inactive)
  await expect(alerts()).rejects.toThrow('perfil')
})

test('administração audita a edição de perfis e bloqueia alterações não autorizadas', async () => {
  const edit = (target: string, version: number, role = 'VENDAS', active = true) => db.query(
    'select public.manage_profile($1,$2,$3,$4,$5,true,false) version', [target, version, 'Nome revisado', role, active],
  )
  await db.exec('begin')
  try {
    await asUser(admin)
    expect((await edit(sales,1)).rows).toEqual([{ version: 2 }])
    expect((await db.query('select action from public.audit_logs where action=$1',['GERENCIAR_PERFIL'])).rows).toHaveLength(1)
  } finally { await db.exec('rollback') }
  await asUser(sales)
  await expect(edit(sales,1)).rejects.toThrow('Somente Administração')
  await asUser(admin)
  await expect(edit(admin,1,'ADMINISTRADOR',false)).rejects.toThrow('outro administrador')
  await expect(edit(sales,20)).rejects.toThrow('perfil mudou')
})

test('vincula uma conta confirmada sem conceder permissões técnicas', async () => {
  const target = crypto.randomUUID()
  await db.exec('reset role; begin')
  try {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())',[target,'conta@example.invalid'])
    await asUser(admin)
    const link = () => db.query("select public.link_auth_profile('CONTA@example.invalid','Conta teste','PRODUCAO') id")
    expect((await link()).rows).toEqual([{ id: target }])
    expect((await db.query('select can_release_lot,can_approve_recipe from public.profiles where id=$1',[target])).rows)
      .toEqual([{ can_release_lot: false, can_approve_recipe: false }])
    await expect(link()).rejects.toThrow('já possui perfil')
  } finally { await db.exec('rollback') }
})

test('rejeita duplicidades e desfaz toda a carga se um ingrediente for inválido', async () => {
  await asUser(admin)
  await expect(importRecords([products[0]!, products[0]!])).rejects.toThrow('duplicados')
  const [sample] = formulas
  await expect(importRecords([{ ...products[0]!, codigo_original: '2' }], [{
    ...sample!, codigo: 'INVALIDA', ingredientes: [{ ...sample!.ingredientes[0]!, unidade: 'inválida' }],
  }])).rejects.toThrow()
  expect((await db.query("select id from public.items where original_code = '2'")).rows).toHaveLength(0)
  expect((await db.query("select id from public.recipes where code = 'INVALIDA'")).rows).toHaveLength(0)
})

test('RLS protege formulação, perfis, auditoria e escrita direta', async () => {
  await asUser(sales)
  expect((await db.query('select id from public.items')).rows).toHaveLength(1)
  expect((await db.query('select id from public.profiles')).rows).toHaveLength(1)
  for (const table of ['recipes', 'recipe_versions', 'recipe_ingredients', 'audit_logs']) {
    expect((await db.query('select id from public.' + table)).rows).toHaveLength(0)
  }
  await expect(importRecords()).rejects.toThrow('administrador')
  await asUser(production)
  expect((await db.query('select id from public.recipe_ingredients')).rows).toHaveLength(1)
  await expect(importRecords()).rejects.toThrow('administrador')
  await asUser(admin)
  await expect(db.query("update public.recipe_versions set status = 'APROVADA'")).rejects.toThrow('permission denied')
  await asUser(inactive)
  expect((await db.query('select id from public.items')).rows).toHaveLength(0)
  await expect(importRecords()).rejects.toThrow('administrador')
  await db.exec('set role anon')
  await expect(db.query('select id from public.items')).rejects.toThrow('permission denied')
  await expect(importRecords()).rejects.toThrow('permission denied')
})

test('prévia usa o CSV original e rejeita linha duplicada', async () => {
  const header = 'codigo_original;descricao_original;classificacao_preliminar;status_validacao\n'
  const row = '31;PALMITO 1800 KG ;REVENDA_A_VALIDAR;PENDENTE_VALIDACAO\n'
  expect((await previewImport(new File([header + row], 'produtos.csv'))).products[0]?.descricao_original).toBe('PALMITO 1800 KG ')
  await expect(previewImport(new File([header + row + row], 'produtos.csv'))).rejects.toThrow('duplicados')
})

test.skipIf(!process.env.PUREZZA_IMPORT_DIR)('valida os anexos reais em banco descartável', async () => {
  const root = process.env.PUREZZA_IMPORT_DIR!
  const csv = await readFile(root + '/produtos_importacao.csv', 'utf8')
  const json = await readFile(root + '/receitas_preliminares.json', 'utf8')
  const payload = await previewImport(new File([csv], 'produtos.csv'), new File([json], 'receitas.json'))
  expect(payload.products).toHaveLength(37)
  expect(payload.products.map(item => item.codigo_original)).not.toContain('23')
  expect(payload.formulas).toHaveLength(9)
  await asUser(admin)
  const result = await db.transaction(async tx => {
    // Use an isolated namespace of SKU values by removing the fictitious fixture inside this transaction.
    await tx.exec('reset role')
    await tx.exec("delete from public.items where original_code = '1'")
    await tx.exec('set local role authenticated')
    const first = await tx.query<{ result: Record<string, number> }>(
      'select public.import_preliminary($1, $2) result',
      [JSON.stringify(payload.products), JSON.stringify(payload.formulas)],
    )
    const firstResult = first.rows[0]?.result
    await tx.rollback()
    return firstResult
  })
  expect(result).toEqual({ produtos_inseridos: 37, produtos_existentes: 0, versoes_inseridas: 9, versoes_existentes: 0 })
})

test('recebimento idempotente, liberação autorizada e FEFO parcial', async () => {
  await db.exec('reset role')
  await db.exec(`
    update public.profiles set can_release_lot = true where id = '${admin}';
    insert into public.items(original_code, original_description, classification, base_unit)
      values('TEST-EST', 'Insumo fictício', 'INSUMO', 'kg');
    insert into public.suppliers(name) values ('Fornecedor fictício');
    insert into public.manufacturers(name) values ('Fabricante fictício');
    insert into public.locations(code) values ('TEST-01');
  `)
  const { rows: [refs] } = await db.query<Record<string, string>>(`
    select (select id from public.items where original_code = 'TEST-EST') item_id,
      (select id from public.suppliers limit 1) supplier_id,
      (select id from public.manufacturers limit 1) manufacturer_id,
      (select id from public.locations limit 1) location_id
  `)
  const payload = { ...refs, original_lot: 'TESTE', unit: 'kg', quantity: '4.250001', invoice_number: 'TESTE-1', expiry: 'INFORMADA', expires_on: '2099-02-01' }
  const receipt = async (input: Record<string, unknown>, requestId = globalThis.crypto.randomUUID()) =>
    (await db.query<{ id: string }>('select public.receive_stock($1,$2) id', [JSON.stringify(input), requestId])).rows[0]!.id
  const decide = (id: string, status: string, version = 1, key = globalThis.crypto.randomUUID()) => db.query(
    'select public.decide_inventory_lot($1,$2,$3,$4,$5)', [id, version, status, 'Decisão fictícia', key],
  )
  const fefo = async () => (await db.query<{ lot_id: string; suggested_quantity: string }>(
    'select lot_id,suggested_quantity from public.suggest_fefo_lots($1,$2)', [refs!.item_id, 6],
  )).rows.map(row => [row.lot_id, Number(row.suggested_quantity)])
  await asUser(production)
  const key = globalThis.crypto.randomUUID()
  const later = await receipt(payload, key)
  expect(await receipt(payload, key)).toBe(later)
  await expect(receipt({ ...payload, quantity: '6' }, key)).rejects.toThrow('outros dados')
  await expect(receipt({ ...payload, quantity: '-1' })).rejects.toThrow('quantidade')
  await expect(receipt({ ...payload, quantity: 'NaN' })).rejects.toThrow('quantidade')
  const earlier = await receipt({ ...payload, expires_on: '2099-01-01' })
  const expired = await receipt({ ...payload, expires_on: '2000-01-01' })
  const undocumented = await receipt({ ...payload, invoice_number: null, documentation_reason: 'Teste' })
  const unknown = await receipt({ ...payload, expires_on: null, expiry: 'DESCONHECIDA' })
  expect(await fefo()).toEqual([])
  await expect(decide(later, 'LIBERADO')).rejects.toThrow('administrador')
  await asUser(inactive)
  await expect(receipt(payload)).rejects.toThrow('perfil')
  await asUser(admin)
  await expect(decide(expired, 'LIBERADO')).rejects.toThrow('validade')
  await expect(decide(undocumented, 'LIBERADO')).rejects.toThrow('documentação')
  await expect(decide(unknown, 'LIBERADO')).rejects.toThrow('validade')
  const decisionKey = globalThis.crypto.randomUUID()
  await decide(later, 'LIBERADO', 1, decisionKey)
  await decide(later, 'LIBERADO', 1, decisionKey)
  await decide(earlier, 'LIBERADO')
  expect(await fefo()).toEqual([[earlier, 4.250001], [later, 1.749999]])
  await expect(decide(earlier, 'BLOQUEADO')).rejects.toThrow('lote mudou')
  await decide(earlier, 'BLOQUEADO', 2)
  expect(await fefo()).toEqual([[later, 4.250001]])
  expect((await db.query('select id from public.stock_movements')).rows).toHaveLength(5)
  expect((await db.query('select id from public.lot_releases')).rows).toHaveLength(3)
  await expect(db.query('update public.stock_balances set quantity = -1')).rejects.toThrow('permission denied')
  await asUser(sales)
  expect(await fefo()).toEqual([])
  await expect(receipt(payload)).rejects.toThrow('perfil')
})

test('transfere saldo em duas pernas, preserva o lote e rejeita saldo insuficiente', async () => {
  await db.exec('reset role')
  await db.exec(`
    insert into public.items(original_code, original_description, classification, base_unit)
      values('TEST-TRF', 'Insumo fictício para transferência', 'INSUMO', 'kg');
    insert into public.suppliers(name) values ('Fornecedor de transferência fictício');
    insert into public.manufacturers(name) values ('Fabricante de transferência fictício');
  `)
  const locations = (await db.query<{ id: string }>(
    "insert into public.locations(code) values ('TEST-T1'), ('TEST-T2') returning id",
  )).rows.map(row => row.id)
  const [origin, destination] = locations
  const [refs] = (await db.query<Record<string, string>>(`
    select (select id from public.items where original_code = 'TEST-TRF') item_id,
      (select id from public.suppliers where name = 'Fornecedor de transferência fictício') supplier_id,
      (select id from public.manufacturers where name = 'Fabricante de transferência fictício') manufacturer_id
  `)).rows
  await asUser(production)
  const payload = { ...refs, location_id: origin, original_lot: 'TRANSFER', unit: 'kg',
    quantity: '10', invoice_number: 'TESTE-2', expiry: 'DESCONHECIDA' }
  const lot = (await db.query<{ id: string }>('select public.receive_stock($1,$2) id',
    [JSON.stringify(payload), crypto.randomUUID()])).rows[0]!.id
  const transfer = async (amount: number, key = crypto.randomUUID(), target = destination) =>
    (await db.query<{ id: string }>('select public.transfer_stock($1,$2,$3,$4,$5) id',
      [lot, origin, target, amount, key])).rows[0]!.id
  const key = crypto.randomUUID()
  const id = await transfer(4.25, key)
  expect(await transfer(4.25, key)).toBe(id)
  await expect(transfer(1, key)).rejects.toThrow('outros dados')
  await expect(transfer(6)).rejects.toThrow('insuficiente')
  await expect(transfer(1, crypto.randomUUID(), origin)).rejects.toThrow('locais distintos')
  const balances = await db.query<{ location_id: string; quantity: string }>(
    'select location_id, quantity from public.stock_balances where lot_id = $1', [lot],
  )
  expect(Object.fromEntries(balances.rows.map(row => [row.location_id, Number(row.quantity)])))
    .toEqual({ [origin!]: 5.75, [destination!]: 4.25 })
  const ledger = await db.query<{ correlation_id: string; quantity_delta: string }>(
    "select correlation_id, quantity_delta from public.stock_movements where lot_id = $1 and kind = 'TRANSFERENCIA' order by quantity_delta", [lot],
  )
  expect(ledger.rows.map(row => [row.correlation_id, Number(row.quantity_delta)])).toEqual([[id, -4.25], [id, 4.25]])
  expect((await db.query('select status from public.inventory_lots where id = $1', [lot])).rows)
    .toEqual([{ status: 'QUARENTENA' }])
  await asUser(sales)
  await expect(transfer(1)).rejects.toThrow('perfil')
})

test('aprova contagem uma vez e bloqueia ajuste após movimentação concorrente', async () => {
  await db.exec('reset role')
  const [refs] = (await db.query<Record<string, string>>(`
    with item as (
      insert into public.items(original_code, original_description, classification, base_unit)
      values ('TEST-COUNT', 'Item fictício', 'INSUMO', 'kg') returning id
    ), supplier as (
      insert into public.suppliers(name) values ('Fornecedor de contagem fictício') returning id
    ), maker as (
      insert into public.manufacturers(name) values ('Fabricante de contagem fictício') returning id
    ), origin as (
      insert into public.locations(code) values ('TEST-C1') returning id
    ), destination as (
      insert into public.locations(code) values ('TEST-C2') returning id
    )
    select item.id item_id, supplier.id supplier_id, maker.id manufacturer_id,
      origin.id location_id, destination.id destination_id from item, supplier, maker, origin, destination
  `)).rows
  await asUser(production)
  const payload = { ...refs, original_lot: 'CONTAGEM', unit: 'kg', quantity: '10', invoice_number: 'TESTE-3', expiry: 'DESCONHECIDA' }
  const lot = (await db.query<{ id: string }>('select public.receive_stock($1,$2) id',
    [JSON.stringify(payload), crypto.randomUUID()])).rows[0]!.id
  const count = async (amount: number, key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.record_inventory_count($1,$2,$3,$4,$5) id',
    [lot, refs!.location_id, amount, 'Contagem fictícia', key],
  )).rows[0]!.id
  const review = (id: string, approve = true, key = crypto.randomUUID()) => db.query(
    'select public.review_inventory_count($1,$2,$3,$4)', [id, approve, 'Revisão fictícia', key],
  )
  const balance = async () => Number((await db.query<{ quantity: string }>(
    'select quantity from public.stock_balances where lot_id = $1 and location_id = $2', [lot, refs!.location_id],
  )).rows[0]!.quantity)
  const key = crypto.randomUUID()
  const id = await count(7.5, key)
  expect(await count(7.5, key)).toBe(id)
  expect(await balance()).toBe(10)
  await expect(review(id)).rejects.toThrow('administrador')
  await asUser(admin)
  const revision = crypto.randomUUID()
  await review(id, true, revision)
  await review(id, true, revision)
  expect(await balance()).toBe(7.5)
  const stale = await count(6)
  await db.query('select public.transfer_stock($1,$2,$3,$4,$5)',
    [lot, refs!.location_id, refs!.destination_id, 1, crypto.randomUUID()])
  await db.query('select public.transfer_stock($1,$2,$3,$4,$5)',
    [lot, refs!.destination_id, refs!.location_id, 1, crypto.randomUUID()])
  await expect(review(stale)).rejects.toThrow('estoque mudou')
  await review(stale, false)
  expect(await balance()).toBe(7.5)
  expect((await db.query<{ quantity_delta: string }>(
    "select quantity_delta from public.stock_movements where lot_id = $1 and kind = 'AJUSTE_INVENTARIO'", [lot],
  )).rows.map(row => Number(row.quantity_delta))).toEqual([-2.5])
  await asUser(sales)
  expect((await db.query('select id from public.inventory_counts')).rows).toHaveLength(0)
})

test('abre lote existente sem recebimento fictício e só disponibiliza após contagem e liberação', async () => {
  await db.exec('reset role')
  const [refs] = (await db.query<Record<string, string>>(`
    with item as (
      insert into public.items(original_code, original_description, classification, base_unit)
      values ('TEST-OPEN', 'Item fictício', 'INSUMO', 'kg') returning id
    ), maker as (
      insert into public.manufacturers(name) values ('Fabricante de abertura fictício') returning id
    ), location as (
      insert into public.locations(code) values ('TEST-O1') returning id
    )
    select item.id item_id, maker.id manufacturer_id, location.id location_id from item, maker, location
  `)).rows
  await db.query('update public.profiles set can_release_lot = true where id = $1', [admin])
  const payload = { ...refs, original_lot: 'ABERTURA-TESTE', unit: 'kg', quantity: '10.25',
    expiry: 'INFORMADA', expires_on: '2099-01-01', opening_reference: 'Contagem fictícia', opening_invoice: 'NF-TESTE' }
  const open = async (input = payload, key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.open_inventory_lot($1,$2) id', [JSON.stringify(input), key],
  )).rows[0]!.id
  const approve = async (lot: string) => {
    const [count] = (await db.query<{ id: string }>('select id from public.inventory_counts where lot_id = $1', [lot])).rows
    await db.query('select public.review_inventory_count($1,true,$2,$3)', [count!.id, 'Aprovação fictícia', crypto.randomUUID()])
  }
  const release = (lot: string) => db.query(
    "select public.decide_inventory_lot($1,1,'LIBERADO',$2,$3)", [lot, 'Liberação fictícia', crypto.randomUUID()],
  )
  await asUser(production)
  await expect(open()).rejects.toThrow('administrador')
  await asUser(admin)
  const key = crypto.randomUUID()
  const lot = await open(payload, key)
  expect(await open(payload, key)).toBe(lot)
  await expect(open()).rejects.toThrow('Já existe abertura')
  expect((await db.query('select receipt_id,status from public.inventory_lots where id = $1', [lot])).rows)
    .toEqual([{ receipt_id: null, status: 'QUARENTENA' }])
  expect((await db.query('select quantity from public.stock_balances where lot_id = $1', [lot])).rows).toHaveLength(0)
  await expect(release(lot)).rejects.toThrow('contagem inicial')
  await approve(lot)
  const [movement] = (await db.query<{ kind: string; quantity_delta: string }>(
    'select kind,quantity_delta from public.stock_movements where lot_id = $1', [lot],
  )).rows
  expect([movement?.kind, Number(movement?.quantity_delta)]).toEqual(['ABERTURA_INVENTARIO', 10.25])
  await release(lot)
  expect((await db.query('select lot_id from public.suggest_fefo_lots($1,1)', [refs!.item_id])).rows)
    .toEqual([{ lot_id: lot }])
  const undocumented = await open({ ...payload, original_lot: 'SEM-DOC-TESTE', opening_invoice: '' })
  await approve(undocumented)
  await expect(release(undocumented)).rejects.toThrow('documento de origem')
})

test('etiqueta usa entrada inicial e audita reimpressões por solicitação', async () => {
  await db.exec('reset role')
  const [refs] = (await db.query<Record<string, string>>(`
    with item as (
      insert into public.items(original_code, original_description, classification, base_unit)
      values ('TEST-LABEL', 'Item fictício para etiqueta', 'INSUMO', 'kg') returning id
    ), supplier as (
      insert into public.suppliers(name) values ('Fornecedor fictício de etiqueta') returning id
    ), maker as (
      insert into public.manufacturers(name) values ('Fabricante fictício de etiqueta') returning id
    ), origin as (
      insert into public.locations(code) values ('TEST-QR1') returning id
    ), destination as (
      insert into public.locations(code) values ('TEST-QR2') returning id
    )
    select item.id item_id, supplier.id supplier_id, maker.id manufacturer_id,
      origin.id location_id, destination.id destination_id from item, supplier, maker, origin, destination
  `)).rows
  await asUser(production)
  const payload = { ...refs, original_lot: 'ETIQUETA-TESTE', unit: 'kg', quantity: '12.25',
    expiry: 'INFORMADA', expires_on: '2099-01-01', invoice_number: 'NF-TESTE' }
  const lot = (await db.query<{ id: string }>('select public.receive_stock($1,$2) id',
    [JSON.stringify(payload), crypto.randomUUID()])).rows[0]!.id
  await db.query('select public.transfer_stock($1,$2,$3,$4,$5)',
    [lot, refs!.location_id, refs!.destination_id, 1, crypto.randomUUID()])
  const request = async (key = crypto.randomUUID(), target = lot) => (await db.query<{ label: Record<string, string> }>(
    'select public.request_inventory_label($1,$2) label', [target, key],
  )).rows[0]!.label
  const key = crypto.randomUUID()
  const label = await request(key)
  expect(label).toMatchObject({ initial_quantity: '12.250000', initial_location: 'TEST-QR1',
    document: 'NF-TESTE', manufacturer: 'Fabricante fictício de etiqueta', original_lot: 'ETIQUETA-TESTE' })
  expect(label.internal_code).toMatch(/^REC-[a-f0-9]{32}$/)
  expect(await request(key)).toEqual(label)
  await expect(request(key, crypto.randomUUID())).rejects.toThrow('outros dados')
  expect(await request()).toEqual(label)
  expect((await db.query('select id from public.inventory_label_requests')).rows).toHaveLength(0)
  await asUser(admin)
  expect((await db.query('select id from public.inventory_label_requests where lot_id = $1', [lot])).rows).toHaveLength(2)
  await asUser(sales)
  await expect(request()).rejects.toThrow('perfil')
})

test('posição por data usa o fim do dia em São Paulo, filtros e paginação', async () => {
  await db.exec('reset role')
  const [refs] = (await db.query<Record<string, string>>(`
    with item as (
      insert into public.items(original_code, original_description, classification, base_unit)
      values ('TEST-POS', 'Item fictício para posição', 'INSUMO', 'kg') returning id
    ), supplier as (
      insert into public.suppliers(name) values ('Fornecedor fictício de posição') returning id
    ), maker as (
      insert into public.manufacturers(name) values ('Fabricante fictício de posição') returning id
    ), origin as (
      insert into public.locations(code) values ('TEST-P1') returning id
    ), destination as (
      insert into public.locations(code) values ('TEST-P2') returning id
    )
    select item.id item_id, supplier.id supplier_id, maker.id manufacturer_id,
      origin.id location_id, destination.id destination_id from item, supplier, maker, origin, destination
  `)).rows
  const payload = { ...refs, original_lot: 'POSICAO', unit: 'kg', quantity: '10.25',
    expiry: 'DESCONHECIDA', invoice_number: 'NF-TESTE' }
  await asUser(production)
  const lotId = (await db.query<{ id: string }>('select public.receive_stock($1,$2) id',
    [JSON.stringify(payload), crypto.randomUUID()])).rows[0]!.id
  await db.query('select public.transfer_stock($1,$2,$3,$4,$5)',
    [lotId, refs!.location_id, refs!.destination_id, 4, crypto.randomUUID()])
  await db.exec('reset role')
  await db.query(`
    update public.stock_movements set created_at = case when kind = 'RECEBIMENTO'
      then '2024-05-02 02:59:59+00'::timestamptz else '2024-05-02 03:00:00+00'::timestamptz end
    where lot_id = $1
  `, [lotId])
  await asUser(production)
  const report = async (day: string, location: string | null = null, limit = 25, offset = 0) =>
    (await db.query<{ report: { total: number; rows: Record<string, string>[] } }>(
      'select public.stock_position($1,$2,$3,$4,$5) report', [day, refs!.item_id, location, limit, offset],
    )).rows[0]!.report
  expect(await report('2024-04-30')).toEqual({ total: 0, rows: [] })
  expect(await report('2024-05-01')).toMatchObject({
    total: 1, rows: [{ item_code: 'TEST-POS', location_code: 'TEST-P1', quantity: '10.250000' }],
  })
  expect(await report('2024-05-02', null, 1, 0)).toMatchObject({
    total: 2, rows: [{ location_code: 'TEST-P1', quantity: '6.250000' }],
  })
  expect(await report('2024-05-02', null, 1, 1)).toMatchObject({
    total: 2, rows: [{ location_code: 'TEST-P2', quantity: '4.000000' }],
  })
  expect(await report('2024-05-02', refs!.destination_id!)).toMatchObject({
    total: 1, rows: [{ location_code: 'TEST-P2', quantity: '4.000000' }],
  })
  await expect(report('2099-01-01')).rejects.toThrow('data válida')
  await expect(report('2024-05-02', null, 101)).rejects.toThrow('paginação')
  const download = () => db.query<{ data: { total: number; rows: unknown[]; generated_at: string } }>(
    "select public.export_stock_position('2024-05-02',$1,null) data", [refs!.item_id],
  )
  const exported = (await download()).rows[0]!.data
  expect(exported.total).toBe(2)
  expect(exported.rows).toEqual((await report('2024-05-02')).rows)
  expect(new Date(exported.generated_at).getTime()).not.toBeNaN()
  await asUser(sales)
  await expect(report('2024-05-02')).rejects.toThrow('perfil')
  await expect(download()).rejects.toThrow('perfil')
})

test('sessão agrupa contagens por local e exige revisão antes do encerramento', async () => {
  await db.exec('reset role')
  const [fixture] = (await db.query<Record<string, string>>(`
    with item as (
      insert into public.items(original_code, original_description, classification, base_unit)
      values ('TEST-SESSION', 'Item fictício de sessão', 'INSUMO', 'kg') returning id
    ), supplier as (
      insert into public.suppliers(name) values ('Fornecedor fictício da sessão') returning id
    ), maker as (
      insert into public.manufacturers(name) values ('Fabricante fictício da sessão') returning id
    ), location as (
      insert into public.locations(code) values ('TEST-S1') returning id
    )
    select item.id item_id, supplier.id supplier_id, maker.id manufacturer_id,
      location.id location_id from item, supplier, maker, location
  `)).rows
  await asUser(production)
  const payload = { ...fixture, original_lot: 'SESSAO-TESTE', unit: 'kg', quantity: '7.5',
    expiry: 'DESCONHECIDA', invoice_number: 'NF-TESTE' }
  const lot = (await db.query<{ id: string }>('select public.receive_stock($1,$2) id',
    [JSON.stringify(payload), crypto.randomUUID()])).rows[0]!.id
  const open = async (key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.open_inventory_session($1,$2,$3) id', [fixture!.location_id, 'Inventário fictício', key],
  )).rows[0]!.id
  const key = crypto.randomUUID()
  const session = await open(key)
  expect(await open(key)).toBe(session)
  await expect(open()).rejects.toThrow('sessão aberta')
  const count = async (key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.record_session_count($1,$2,$3,$4,$5) id',
    [session, lot, '7.5', 'Contagem fictícia', key],
  )).rows[0]!.id
  const close = (key = crypto.randomUUID()) => db.query('select public.close_inventory_session($1,$2,$3)',
    [session, 'Fechamento fictício', key])
  const countKey = crypto.randomUUID()
  const first = await count(countKey)
  expect(await count(countKey)).toBe(first)
  await expect(count()).rejects.toThrow('já tem uma contagem')
  expect((await db.query('select session_id,location_id from public.inventory_counts where id = $1', [first])).rows)
    .toEqual([{ session_id: session, location_id: fixture!.location_id }])
  await expect(close()).rejects.toThrow('administrador')
  await asUser(admin)
  await expect(close()).rejects.toThrow('contagens pendentes')
  await db.query('select public.review_inventory_count($1,false,$2,$3)', [first, 'Recontar', crypto.randomUUID()])
  const second = await count()
  await db.query('select public.review_inventory_count($1,true,$2,$3)', [second, 'Aprovada', crypto.randomUUID()])
  const closeKey = crypto.randomUUID()
  await close(closeKey)
  await close(closeKey)
  await expect(count()).rejects.toThrow('sessão precisa estar aberta')
  expect(await open()).not.toBe(session)
  await asUser(sales)
  expect((await db.query('select id from public.inventory_sessions')).rows).toHaveLength(0)
  await expect(open()).rejects.toThrow('perfil')
})

test('cadastro comercial valida documentos, isola dados pessoais e protege edições concorrentes', async () => {
  await asUser(sales)
  const basic = { kind: 'PF', legal_name: 'Pessoa fictícia', document: '529.982.247-25',
    postal_code: '13470-000', uf: 'sp', email: 'teste@example.invalid', payment_days: '30' }
  const save = async (input: Record<string, unknown>, target: string | null = null, version: number | null = null,
    key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.save_customer($1,$2,$3,$4) id', [target, version, JSON.stringify(input), key],
  )).rows[0]!.id
  const key = crypto.randomUUID()
  const id = await save(basic, null, null, key)
  expect(await save(basic, null, null, key)).toBe(id)
  await expect(save({ ...basic, legal_name: 'Outro nome' }, null, null, key)).rejects.toThrow('outros dados')
  await expect(save(basic)).rejects.toThrow('duplicate')
  await expect(save({ ...basic, document: '52998224724' })).rejects.toThrow('CPF ou CNPJ inválido')
  await expect(save({ ...basic, document: '11111111111' })).rejects.toThrow('CPF ou CNPJ inválido')
  const [normalized] = (await db.query('select document,postal_code,uf,payment_days,version from public.customers where id = $1', [id])).rows
  expect(normalized).toEqual({ document: '52998224725', postal_code: '13470000', uf: 'SP', payment_days: 30, version: 1 })
  const company = await save({ kind: 'PJ', legal_name: 'Empresa fictícia', document: '12.abc.345/01de-35' })
  expect((await db.query('select document from public.customers where id = $1', [company])).rows)
    .toEqual([{ document: '12ABC34501DE35' }])
  await save({ kind: 'PJ', legal_name: 'Empresa de teste', document: '11.222.333/0001-81' })
  await expect(save({ kind: 'PF', legal_name: 'Pessoa incorreta', document: '12ABC34501DE35' }))
    .rejects.toThrow('CPF ou CNPJ inválido')
  await save({ ...basic, legal_name: 'Pessoa fictícia atualizada', active: false }, id, 1)
  await expect(save(basic, id, 1)).rejects.toThrow('cadastro mudou')
  expect((await db.query('select version,active from public.customers where id = $1', [id])).rows)
    .toEqual([{ version: 2, active: false }])
  await expect(db.query('update public.customers set active=true')).rejects.toThrow('permission denied')
  await asUser(production)
  expect((await db.query('select id from public.customers')).rows).toHaveLength(0)
  await expect(save(basic)).rejects.toThrow('perfil')
  await asUser(admin)
  expect((await db.query("select details from public.audit_logs where action='SALVAR_CLIENTE' and details->>'cliente_id' = $1 order by details->>'criacao' desc", [id])).rows)
    .toEqual([{ details: { cliente_id: id, criacao: true } }, { details: { cliente_id: id, criacao: false } }])
  await asUser(inactive)
  expect((await db.query('select id from public.customers')).rows).toHaveLength(0)
})

test('rascunho calcula totais em BRL e mantém valores restritos ao comercial', async () => {
  await db.exec('reset role')
  const [refs] = (await db.query<Record<string, string>>(`
    with customer as (
      insert into public.customers(kind, legal_name, created_by, updated_by)
      values ('PJ', 'Cliente de pedido fictício', $1, $1) returning id
    ), first_item as (
      insert into public.items(original_code, original_description, classification, base_unit)
      values ('TEST-ORDER-KG', 'Produto fictício em kg', 'FABRICACAO_PROPRIA', 'kg') returning id
    ), second_item as (
      insert into public.items(original_code, original_description, classification, base_unit)
      values ('TEST-ORDER-UN', 'Produto fictício em un', 'TERCEIRO', 'un') returning id
    )
    select customer.id customer_id, first_item.id item_one, second_item.id item_two from customer, first_item, second_item
  `, [admin])).rows
  await asUser(sales)
  const payload = { customer_id: refs!.customer_id, payment_terms: 'A prazo',
    operational_notes: 'Operacional fictícia', commercial_notes: 'Comercial fictícia', items: [
      { item_id: refs!.item_one, unit: 'kg', quantity: '0.5', unit_price: '2.15', discount: '0.03' },
      { item_id: refs!.item_two, unit: 'un', quantity: '3', unit_price: '2.00' },
    ] }
  const create = async (input = payload, key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.create_order_draft($1,$2) id', [JSON.stringify(input), key],
  )).rows[0]!.id
  const key = crypto.randomUUID()
  const order = await create(payload, key)
  expect(await create(payload, key)).toBe(order)
  await expect(create({ ...payload, payment_terms: 'Outra' }, key)).rejects.toThrow('outros dados')
  expect((await db.query('select fulfillment_status,seller_id from public.orders where id = $1', [order])).rows)
    .toEqual([{ fulfillment_status: 'RASCUNHO', seller_id: sales }])
  expect((await db.query('select total,billing_status from public.order_financials where order_id = $1', [order])).rows)
    .toEqual([{ total: '7.05', billing_status: 'NAO_FATURADO' }])
  expect((await db.query('select unit,kg_per_unit from public.order_items where order_id = $1 order by line_number', [order])).rows)
    .toEqual([{ unit: 'kg', kg_per_unit: '1.000000' }, { unit: 'un', kg_per_unit: null }])
  await expect(create({ ...payload, items: [payload.items[0]!, payload.items[0]!] })).rejects.toThrow('única linha')
  await expect(create({ ...payload, items: [payload.items[0]!, { ...payload.items[1]!, quantity: '1.1' }] })).rejects.toThrow('quantidade')
  await expect(create({ ...payload, items: [{ ...payload.items[0]!, discount: '9' }] })).rejects.toThrow('total do item')
  expect((await db.query('select id from public.orders where customer_id = $1', [refs!.customer_id])).rows).toHaveLength(1)
  await asUser(production)
  for (const relation of ['orders', 'order_items', 'order_financials', 'order_item_financials']) {
    expect((await db.query('select * from public.' + relation)).rows).toHaveLength(0)
  }
  await expect(create()).rejects.toThrow('perfil')
})

test('edição de rascunho preserva número, recalcula valores e rejeita versão desatualizada', async () => {
  await db.exec('reset role')
  const [refs] = (await db.query<Record<string, string>>(`
    with customer as (
      insert into public.customers(kind, legal_name, created_by, updated_by)
      values ('PJ', 'Cliente fictício de edição', $1, $1) returning id
    ), item as (
      insert into public.items(original_code, original_description, classification, base_unit)
      values ('TEST-EDIT', 'Produto fictício', 'TERCEIRO', 'un') returning id
    )
    select customer.id customer_id, item.id item_id from customer, item
  `, [admin])).rows
  await asUser(sales)
  const payload = { customer_id: refs!.customer_id, items: [
    { item_id: refs!.item_id, unit: 'un', quantity: '2', unit_price: '2.50' },
  ] }
  const order = (await db.query<{ id: string }>('select public.create_order_draft($1,$2) id',
    [JSON.stringify(payload), crypto.randomUUID()])).rows[0]!.id
  const edit = async (input: typeof payload, version = 1, key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.edit_order_draft($1,$2,$3,$4) id', [order, version, JSON.stringify(input), key],
  )).rows[0]!.id
  const summary = async () => (await db.query<{ order_number: number; version: number; seller_id: string; total: string }>(
    'select o.order_number, o.version, o.seller_id, f.total from public.orders o join public.order_financials f on f.order_id=o.id where o.id=$1',
    [order],
  )).rows[0]
  const before = await summary()
  await expect(edit({ ...payload, items: [{ ...payload.items[0]!, quantity: '2.5' }] })).rejects.toThrow('quantidade')
  expect(await summary()).toEqual(before)
  expect((await db.query('select quantity from public.order_items where order_id=$1', [order])).rows)
    .toEqual([{ quantity: '2.000000' }])
  await asUser(admin)
  const revised = { ...payload, items: [{ ...payload.items[0]!, quantity: '3' }] }
  const key = crypto.randomUUID()
  expect(await edit(revised, 1, key)).toBe(order)
  expect(await edit(revised, 1, key)).toBe(order)
  await expect(edit(payload, 1)).rejects.toThrow('pedido mudou')
  expect(await summary()).toEqual({ ...before, version: 2, total: '7.50' })
  expect((await db.query('select quantity from public.order_items where order_id=$1', [order])).rows)
    .toEqual([{ quantity: '3.000000' }])
  await asUser(production)
  await expect(edit(payload, 2)).rejects.toThrow('perfil')
})

test('confirma pedido misto sem duplicar ou expor valores à Produção', async () => {
  await db.exec('reset role')
  const [refs] = (await db.query<Record<string, string>>(`
    with customer as (
      insert into public.customers(kind, legal_name, created_by, updated_by)
      values ('PJ', 'Cliente fictício de confirmação', $1, $1) returning id
    ), products as (
      insert into public.items(original_code, original_description, classification, base_unit) values
        ('TEST-CON-KG', 'Produto próprio de teste', 'FABRICACAO_PROPRIA', 'kg'),
        ('TEST-CON-UN', 'Produto próprio sem conversão de teste', 'FABRICACAO_PROPRIA', 'un'),
        ('TEST-CON-EXT', 'Produto terceirizado de teste', 'TERCEIRO', 'un')
      returning id, original_code
    )
    select customer.id customer_id,
      (select id from products where original_code = 'TEST-CON-KG') kg_id,
      (select id from products where original_code = 'TEST-CON-UN') un_id,
      (select id from products where original_code = 'TEST-CON-EXT') ext_id from customer
  `, [admin])).rows
  await asUser(sales)
  const payload = { customer_id: refs!.customer_id, delivery_date: '2099-02-03', items: [
    { item_id: refs!.kg_id, unit: 'kg', quantity: '0.000001', unit_price: '15.50' },
    { item_id: refs!.un_id, unit: 'un', quantity: '2', unit_price: '10.00' },
    { item_id: refs!.ext_id, unit: 'un', quantity: '4', unit_price: '8.00' },
  ] }
  const create = async (input = payload) => (await db.query<{ id: string }>('select public.create_order_draft($1,$2) id',
    [JSON.stringify(input), crypto.randomUUID()])).rows[0]!.id
  const order = await create()
  const missingDate = await create({ ...payload, delivery_date: '' })
  const confirm = async (id = order, version = 1, key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.confirm_order($1,$2,$3) id', [id, version, key],
  )).rows[0]!.id
  await expect(confirm(missingDate)).rejects.toThrow('data de entrega')
  await expect(confirm(order, 0)).rejects.toThrow('pedido mudou')
  await asUser(production)
  const demands = () => db.query(
    'select item_code,requested_kg,status from public.production_demands where order_id = $1 order by item_code', [order],
  )
  expect((await demands()).rows).toHaveLength(0)
  await expect(confirm()).rejects.toThrow('perfil')
  await asUser(sales)
  const key = crypto.randomUUID()
  expect(await confirm(order, 1, key)).toBe(order)
  expect(await confirm(order, 1, key)).toBe(order)
  await expect(confirm()).rejects.toThrow('pedido mudou')
  await expect(db.query('select public.edit_order_draft($1,2,$2,$3)',
    [order, JSON.stringify(payload), crypto.randomUUID()])).rejects.toThrow('pedido mudou')
  expect((await db.query('select fulfillment_status,version,confirmed_by from public.orders where id = $1', [order])).rows)
    .toEqual([{ fulfillment_status: 'CONFIRMADO', version: 2, confirmed_by: sales }])
  expect((await demands()).rows).toHaveLength(0)
  await asUser(production)
  expect((await demands()).rows).toEqual([
    { item_code: 'TEST-CON-KG', requested_kg: '0.000001000', status: 'AGUARDANDO_PLANEJAMENTO' },
    { item_code: 'TEST-CON-UN', requested_kg: null, status: 'PENDENTE_CONVERSAO' },
  ])
  expect((await db.query('select total from public.order_financials where order_id = $1', [order])).rows).toHaveLength(0)
})

test('planejamento simula 800 kg com média, mínimo e estoque hipotético sem criar ordem', async () => {
  await db.exec('reset role')
  const [refs] = (await db.query<Record<string, string>>(`
    with customer as (
      insert into public.customers(kind, legal_name, created_by, updated_by)
      values ('PJ', 'Cliente fictício de planejamento', $1, $1) returning id
    ), item as (
      insert into public.items(original_code, original_description, classification, base_unit)
      values ('TEST-PLAN', 'Produto próprio fictício', 'FABRICACAO_PROPRIA', 'kg') returning id
    ), recipe as (
      insert into public.recipes(code,name) values ('TEST-PLAN','Receita fictícia de planejamento') returning id
    ), version as (
      insert into public.recipe_versions(recipe_id,version,yield_min,yield_target,yield_max)
      select id,1,133,134,135 from recipe returning id
    ), ingredients as (
      insert into public.recipe_ingredients(recipe_version_id,source_name,ordinal,quantity,unit)
      select id,'Farinha de trigo',1,100,'kg' from version
      union all select id,'Água',2,null,'L' from version
    )
    select customer.id customer_id,item.id item_id,version.id version_id from customer,item,version
  `, [admin])).rows
  await asUser(admin)
  const payload = { customer_id: refs!.customer_id, delivery_date: '2099-02-03', items: [
    { item_id: refs!.item_id, unit: 'kg', quantity: '800', unit_price: '10' },
  ] }
  const order = (await db.query<{ id: string }>('select public.create_order_draft($1,$2) id',
    [JSON.stringify(payload), crypto.randomUUID()])).rows[0]!.id
  await db.query('select public.confirm_order($1,1,$2)', [order, crypto.randomUUID()])
  await asUser(production)
  const demand = (await db.query<{ order_item_id: string }>('select order_item_id from public.production_demands where order_id=$1',
    [order])).rows[0]!.order_item_id
  const plan = async (mode = 'MEDIO', stock = '0') => (await db.query<{ data: Record<string, unknown> }>(
    'select public.calculate_production_plan($1,$2,$3,$4) data', [demand, refs!.version_id, mode, stock],
  )).rows[0]!.data
  const average = await plan()
  const metrics = ['batches', 'net_kg', 'min_output_kg', 'target_output_kg', 'max_output_kg',
    'risk_kg', 'expected_surplus_kg', 'flour_kg', 'flour_sacks_25kg']
  expect(metrics.map(metric => Number(average[metric]))).toEqual([6,800,798,804,810,2,4,600,24])
  expect(average.recipe_status).toBe('PENDENTE_VALIDACAO')
  expect(average.ingredients).toMatchObject([{ name: 'Farinha de trigo' }, { name: 'Água', planned_quantity: null }])
  const conservative = await plan('CONSERVADOR')
  expect([Number(conservative.batches), Number(conservative.min_output_kg), Number(conservative.risk_kg)]).toEqual([7,931,0])
  expect(Number((await plan('MEDIO','130')).batches)).toBe(5)
  expect(Number((await plan('MEDIO','800')).batches)).toBe(0)
  await expect(plan('MEDIO','-1')).rejects.toThrow('quantidade hipotética')
  await asUser(sales)
  await expect(plan()).rejects.toThrow('perfil')
})

test('conversão aprovada resolve demanda pendente e preserva o fator gravado no pedido', async () => {
  await db.exec('reset role')
  const [refs] = (await db.query<Record<string, string>>(`
    with customer as (
      insert into public.customers(kind, legal_name, created_by, updated_by)
      values ('PJ', 'Cliente fictício de conversão', $1, $1) returning id
    ), item as (
      insert into public.items(original_code, original_description, classification)
      values ('TEST-UNIT', 'Produto próprio fictício em unidades', 'FABRICACAO_PROPRIA') returning id
    )
    select customer.id customer_id,item.id item_id from customer,item
  `, [admin])).rows
  const item = refs!.item_id
  const config = (version: number, unit: string, factor: string | null, key = crypto.randomUUID()) => db.query(
    'select public.configure_item_units($1,$2,$3,$4,$5,$6)',
    [item, version, unit, factor, 'Referência técnica fictícia', key],
  )
  await asUser(sales)
  await expect(config(1, 'un', null)).rejects.toThrow('administrador')
  await asUser(admin)
  await config(1, 'un', null)
  await expect(config(1, 'un', '1.250000')).rejects.toThrow('configuração mudou')
  await expect(config(2, 'kg', '1.250000')).rejects.toThrow('fator')
  await asUser(sales)
  const payload = { customer_id: refs!.customer_id, delivery_date: '2099-02-03', items: [
    { item_id: item, unit: 'un', quantity: '4', unit_price: '10' },
  ] }
  const create = async () => (await db.query<{ id: string }>('select public.create_order_draft($1,$2) id',
    [JSON.stringify(payload), crypto.randomUUID()])).rows[0]!.id
  const confirm = (id: string) => db.query('select public.confirm_order($1,1,$2)', [id, crypto.randomUUID()])
  const pending = await create()
  await confirm(pending)
  await asUser(production)
  const demand = async (id: string) => (await db.query<{ order_item_id: string; requested_kg: string | null; status: string }>(
    'select order_item_id,requested_kg,status from public.production_demands where order_id=$1', [id],
  )).rows[0]!
  const pendingId = (await demand(pending)).order_item_id
  const resolve = (key = crypto.randomUUID()) => db.query('select public.resolve_demand_weight($1,$2)', [pendingId, key])
  await expect(resolve()).rejects.toThrow('conversão aprovada')
  await asUser(admin)
  const key = crypto.randomUUID()
  await config(2, 'un', '1.25', key)
  await config(2, 'un', '1.25', key)
  await expect(config(3, 'kg', null)).rejects.toThrow('pedido confirmado')
  await asUser(production)
  const resolveKey = crypto.randomUUID()
  await resolve(resolveKey)
  await resolve(resolveKey)
  expect(await demand(pending)).toMatchObject({ requested_kg: '5.000000000', status: 'AGUARDANDO_PLANEJAMENTO' })
  await asUser(sales)
  const frozen = await create()
  expect((await db.query('select kg_per_unit from public.order_items where order_id=$1', [frozen])).rows)
    .toEqual([{ kg_per_unit: '1.250000' }])
  await asUser(admin)
  await config(3, 'un', '1.5')
  await asUser(sales)
  await confirm(frozen)
  await asUser(production)
  expect(await demand(frozen)).toMatchObject({ requested_kg: '5.000000000' })
  expect(await demand(pending)).toMatchObject({ requested_kg: '5.000000000' })
})

test('faturamento externo parcial e final confere parcelas e restringe registro a Vendas', async () => {
  await db.exec('reset role')
  const [refs] = (await db.query<Record<string, string>>(`
    with customer as (
      insert into public.customers(kind, legal_name, created_by, updated_by)
      values ('PJ','Cliente fictício de faturamento',$1,$1) returning id
    ), item as (
      insert into public.items(original_code, original_description, classification, base_unit)
      values ('TEST-BILL','Produto fictício de faturamento','TERCEIRO','un') returning id
    )
    select customer.id customer_id,item.id item_id from customer,item
  `, [admin])).rows
  await asUser(sales)
  const payload = { customer_id: refs!.customer_id, delivery_date: '2099-02-03', items: [
    { item_id: refs!.item_id, unit: 'un', quantity: '5', unit_price: '20' },
  ] }
  const order = (await db.query<{ id: string }>('select public.create_order_draft($1,$2) id',
    [JSON.stringify(payload), crypto.randomUUID()])).rows[0]!.id
  const first = { invoice_number: 'NF-TEST-1', invoice_series: '1', issued_on: '2025-01-01', amount: '40.50',
    installments: [{ due_on: '2025-01-15', amount: '20.25' }, { due_on: '2025-02-15', amount: '20.25' }] }
  const record = async (input = first, key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.register_billing($1,$2,$3) id', [order, JSON.stringify(input), key],
  )).rows[0]!.id
  const summary = async () => (await db.query(
    'select billing_status,billed_total from public.order_financials where order_id=$1', [order],
  )).rows
  await expect(record()).rejects.toThrow('pedido confirmado')
  await db.query('select public.confirm_order($1,1,$2)', [order, crypto.randomUUID()])
  await asUser(admin)
  await expect(record()).rejects.toThrow('Somente Vendas')
  await asUser(sales)
  await expect(record({ ...first, installments: [first.installments[0]!] })).rejects.toThrow('soma das parcelas')
  expect(await summary()).toEqual([{ billing_status: 'NAO_FATURADO', billed_total: '0.00' }])
  const key = crypto.randomUUID()
  const billing = await record(first, key)
  expect(await record(first, key)).toBe(billing)
  await expect(record({ ...first, invoice_number: 'OUTRA' }, key)).rejects.toThrow('outros dados')
  await expect(record()).rejects.toThrow('duplicate')
  expect(await summary()).toEqual([{ billing_status: 'PARCIAL', billed_total: '40.50' }])
  const last = { ...first, invoice_number: 'NF-TEST-2', amount: '59.50',
    installments: [{ due_on: '2025-02-15', amount: '59.50' }] }
  await expect(record({ ...last, amount: '60.00' })).rejects.toThrow('valor disponível')
  await record(last)
  expect(await summary()).toEqual([{ billing_status: 'FATURADO', billed_total: '100.00' }])
  const issue = () => db.query<{ result: { snapshot_hash: string; snapshot: Record<string, unknown> } }>(
    'select public.issue_commercial_document($1) result', [order],
  )
  const firstDocument = (await issue()).rows[0]!.result
  expect(firstDocument.snapshot_hash).toMatch(/^[a-f0-9]{64}$/)
  expect(firstDocument.snapshot).toMatchObject({ total: '100.00', company: { name: 'Sabor Purezza Massas' } })
  await asUser(admin)
  await expect(issue()).rejects.toThrow('Somente Vendas')
  expect((await db.query('select id from public.commercial_documents')).rows).toHaveLength(0)
  await db.query('select public.configure_commercial_document(1,$1,$2)', [JSON.stringify({
    company_name: 'Nome fictício alterado', company_address: 'Endereço fictício', company_phone: 'Contato fictício',
  }), crypto.randomUUID()])
  expect((await db.query('select id from public.billing_records where order_id=$1', [order])).rows).toHaveLength(2)
  expect((await db.query('select amount from public.billing_installments where billing_id=$1 order by position', [billing])).rows)
    .toEqual([{ amount: '20.25' }, { amount: '20.25' }])
  await asUser(sales)
  expect((await issue()).rows[0]!.result).toEqual(firstDocument)
  expect((await db.query('select id from public.commercial_documents where order_id=$1', [order])).rows).toHaveLength(1)
  await asUser(production)
  await expect(issue()).rejects.toThrow('Somente Vendas')
  expect((await db.query('select id from public.billing_records')).rows).toHaveLength(0)
  expect((await db.query('select amount from public.billing_installments')).rows).toHaveLength(0)
})

test('reserva FEFO preserva o saldo físico e protege a quantidade reservada', async () => {
  await db.exec('reset role')
  await db.query('update public.profiles set can_release_lot=true where id=$1', [admin])
  const [refs] = (await db.query<Record<string, string>>(`
    with customer as (
      insert into public.customers(kind,legal_name,created_by,updated_by) values ('PJ','Cliente fictício de reserva',$1,$1) returning id
    ), item as (
      insert into public.items(original_code,original_description,classification,base_unit)
      values ('TEST-RESERVE','Produto fictício de reserva','TERCEIRO','un') returning id
    ), supplier as (
      insert into public.suppliers(name) values ('Fornecedor fictício de reserva') returning id
    ), maker as (
      insert into public.manufacturers(name) values ('Fabricante fictício de reserva') returning id
    ), origin as (
      insert into public.locations(code) values ('TEST-R1') returning id
    ), destination as (
      insert into public.locations(code) values ('TEST-R2') returning id
    )
    select customer.id customer_id,item.id item_id,supplier.id supplier_id,maker.id manufacturer_id,
      origin.id location_id,destination.id destination_id from customer,item,supplier,maker,origin,destination
  `, [admin])).rows
  await asUser(admin)
  const receive = async (expires_on: string, quantity: string) => {
    const payload = { ...refs, original_lot: expires_on, unit: 'un', quantity, expiry: 'INFORMADA', expires_on, invoice_number: 'NF-TESTE' }
    const lot = (await db.query<{ id: string }>('select public.receive_stock($1,$2) id',
      [JSON.stringify(payload), crypto.randomUUID()])).rows[0]!.id
    await db.query("select public.decide_inventory_lot($1,1,'LIBERADO',$2,$3)", [lot, 'Liberação fictícia', crypto.randomUUID()])
    return lot
  }
  const latest = await receive('2099-03-01','5')
  const first = await receive('2099-02-01','3')
  await receive('2099-01-01','20')
  const payload = { customer_id: refs!.customer_id, delivery_date: '2099-01-05', items: [
    { item_id: refs!.item_id, unit: 'un', quantity: '9', unit_price: '10' },
  ] }
  const order = (await db.query<{ id: string }>('select public.create_order_draft($1,$2) id',
    [JSON.stringify(payload), crypto.randomUUID()])).rows[0]!.id
  const line = (await db.query<{ id: string }>('select id from public.order_items where order_id=$1',[order])).rows[0]!.id
  const reserve = async (amount: number, key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.reserve_order_stock($1,$2,$3) id', [line,amount,key],
  )).rows[0]!.id
  const active = () => db.query('select lot_id,quantity from public.stock_reservations where order_item_id=$1 and released_at is null order by quantity desc',
    [line])
  await expect(reserve(1)).rejects.toThrow('pedido confirmado')
  await db.query('select public.confirm_order($1,1,$2)',[order,crypto.randomUUID()])
  await expect(reserve(9)).rejects.toThrow('Saldo elegível insuficiente')
  expect((await active()).rows).toHaveLength(0)
  const key = crypto.randomUUID()
  const reservation = await reserve(5,key)
  expect(await reserve(5,key)).toBe(reservation)
  expect((await active()).rows).toEqual([{ lot_id:first,quantity:'3.000000' },{ lot_id:latest,quantity:'2.000000' }])
  const fefo = () => db.query('select suggested_quantity from public.suggest_fefo_lots($1,100) where lot_id=$2',[refs!.item_id,latest])
  expect((await fefo()).rows).toEqual([{ suggested_quantity:'3.000000' }])
  expect((await db.query('select quantity from public.stock_balances where lot_id=$1',[first])).rows).toEqual([{ quantity:'3.000000' }])
  const transfer = () => db.query('select public.transfer_stock($1,$2,$3,1,$4)',
    [first,refs!.location_id,refs!.destination_id,crypto.randomUUID()])
  await expect(transfer()).rejects.toThrow('saldo reservado')
  const count = (await db.query<{ id: string }>('select public.record_inventory_count($1,$2,2,$3,$4) id',
    [first,refs!.location_id,'Contagem fictícia',crypto.randomUUID()])).rows[0]!.id
  await expect(db.query('select public.review_inventory_count($1,true,$2,$3)',
    [count,'Ajuste fictício',crypto.randomUUID()])).rejects.toThrow('saldo reservado')
  const release = () => db.query('select public.release_stock_reservation($1,$2,$3)',[reservation,'Liberação fictícia',crypto.randomUUID()])
  await asUser(sales)
  await expect(reserve(1)).rejects.toThrow('administrador')
  expect((await active()).rows).toHaveLength(0)
  await asUser(admin)
  await release()
  await transfer()
  expect((await active()).rows).toEqual([{ lot_id:latest,quantity:'2.000000' }])
  const second = (await db.query<{ id: string }>(
    'select id from public.stock_reservations where order_item_id=$1 and released_at is null',[line],
  )).rows[0]!.id
  const dispatch = async (id: string, amount: number, key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    "select public.confirm_shipment($1,$2,'ENTREGA',null,$3) id",[id,amount,key],
  )).rows[0]!.id
  const queue = async () => (await db.query<{ report: { rows: { id: string; eligible: boolean; remaining: string }[] } }>(
    'select public.shipping_queue(20,0) report',
  )).rows[0]!.report.rows
  await db.query("select public.decide_inventory_lot($1,2,'BLOQUEADO',$2,$3)",
    [latest,'Bloqueio fictício',crypto.randomUUID()])
  await asUser(production)
  expect((await queue()).find(row => row.id === second)).toMatchObject({ eligible: false, remaining: '2.000000' })
  await expect(dispatch(second,1)).rejects.toThrow('lote não está elegível')
  await asUser(admin)
  await db.query("select public.decide_inventory_lot($1,3,'LIBERADO',$2,$3)",
    [latest,'Liberação fictícia',crypto.randomUUID()])
  await asUser(production)
  const shippingKey = crypto.randomUUID()
  const shipment = await dispatch(second,1,shippingKey)
  expect(await dispatch(second,1,shippingKey)).toBe(shipment)
  const markDelivered = (when: string | null = null, key = crypto.randomUUID()) => db.query(
    'select public.confirm_delivery($1,$2,$3,$4)',[shipment,when,'Comprovante fictício',key],
  )
  const history = async (pendingOnly: boolean) => (await db.query<{
    report: { rows: Record<string, unknown>[] }
  }>('select public.shipment_history($1,20,0) report',[pendingOnly])).rows[0]!.report.rows
  expect((await history(true)).find(row => row.id === shipment)).toMatchObject({delivered_at:null})
  await expect(markDelivered('2020-01-01T10:00')).rejects.toThrow('entre o despacho')
  await expect(markDelivered('2099-01-01T10:00')).rejects.toThrow('entre o despacho')
  const deliveryKey = crypto.randomUUID()
  await markDelivered(null,deliveryKey)
  await markDelivered(null,deliveryKey)
  await expect(markDelivered()).rejects.toThrow('entrega pendente')
  expect((await history(true)).some(row => row.id === shipment)).toBe(false)
  expect((await history(false)).find(row => row.id === shipment)).toMatchObject({
    delivered_at: expect.any(String), delivery_reference:'Comprovante fictício',
  })
  const registerReturn = async (amount: number, key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.register_shipment_return($1,$2,$3,$4,$5) id',
    [shipment,refs!.destination_id,amount,'Motivo fictício de devolução',key],
  )).rows[0]!.id
  await expect(registerReturn(2)).rejects.toThrow('quantidade ainda devolvível')
  const returnKey = crypto.randomUUID()
  const returned = await registerReturn(1,returnKey)
  expect(await registerReturn(1,returnKey)).toBe(returned)
  await expect(registerReturn(1)).rejects.toThrow('quantidade ainda devolvível')
  const [returnRow] = (await db.query<{ return_lot_id: string; status: string; expires_on: string; quantity: string }>(
    'select r.return_lot_id,l.status,l.expires_on::text,b.quantity from public.shipment_returns r join public.inventory_lots l on l.id=r.return_lot_id join public.stock_balances b on b.lot_id=l.id where r.id=$1',[returned],
  )).rows
  expect(returnRow).toMatchObject({ status:'QUARENTENA',expires_on:'2099-03-01',quantity:'1.000000' })
  expect(returnRow!.return_lot_id).not.toBe(latest)
  expect((await history(false)).find(row => row.id === shipment)).toMatchObject({
    returnable:'0.000000',returned_lots:[{code:expect.any(String),quantity:'1.000000'}],
  })
  const [returnLabel] = (await db.query<{ label: Record<string, unknown> }>(
    'select public.request_inventory_label($1,$2) label',[returnRow!.return_lot_id,crypto.randomUUID()],
  )).rows
  expect(returnLabel!.label).toMatchObject({document_type:'Pedido de origem',initial_quantity:'1.000000',initial_location:'TEST-R2'})
  const selectedCode = String(returnLabel!.label.internal_code)
  const originalCode = (await db.query<{ internal_code: string }>(
    'select internal_code from public.inventory_lots where id=$1',[latest],
  )).rows[0]!.internal_code
  const trace = async (code: string) => (await db.query<{ report: Record<string, unknown> | null }>(
    'select public.trace_inventory_lot($1) report',[code],
  )).rows[0]!.report
  const backward = await trace(selectedCode)
  expect(backward).toMatchObject({selected_code:selectedCode,root_code:originalCode})
  expect(backward!.lots).toEqual(expect.arrayContaining([
    expect.objectContaining({code:originalCode,origin:'RECEBIMENTO',invoice_number:'NF-TESTE',supplier:'Fornecedor fictício de reserva'}),
    expect.objectContaining({code:selectedCode,origin:'DEVOLUCAO',parent_code:originalCode}),
  ]))
  expect(backward!.destinations).toEqual(expect.arrayContaining([
    expect.objectContaining({id:shipment,code:originalCode,customer_name:'Cliente fictício de reserva',quantity:'1.000000'}),
  ]))
  expect(backward!.movements).toEqual(expect.arrayContaining([
    expect.objectContaining({code:selectedCode,kind:'DEVOLUCAO_EXPEDICAO',delta:'1.000000'}),
  ]))
  expect(backward).not.toHaveProperty('total')
  expect((await trace(originalCode))!.lots).toEqual(backward!.lots)
  expect(await trace('REC-'+'0'.repeat(32))).toBeNull()
  await expect(trace('QR inválido')).rejects.toThrow('código interno')
  await asUser(admin)
  await expect(db.query("select public.decide_inventory_lot($1,1,'LIBERADO',$2,$3)",
    [returnRow!.return_lot_id,'Liberação fictícia',crypto.randomUUID()])).rejects.toThrow('lote devolvido')
  await asUser(production)
  expect((await queue()).find(row => row.id === second)).toMatchObject({ eligible: true, remaining: '1.000000' })
  expect((await db.query('select quantity from public.stock_balances where lot_id=$1',[latest])).rows).toEqual([{quantity:'4.000000'}])
  expect((await fefo()).rows).toEqual([{suggested_quantity:'3.000000'}])
  await expect(dispatch(second,2)).rejects.toThrow('quantidade ainda reservada')
  await asUser(sales)
  await expect(dispatch(second,1)).rejects.toThrow('perfil')
  await expect(queue()).rejects.toThrow('perfil')
  await expect(markDelivered()).rejects.toThrow('perfil')
  await expect(registerReturn(1)).rejects.toThrow('perfil')
  await expect(trace(originalCode)).rejects.toThrow('perfil')
  expect((await history(false)).find(row => row.id === shipment)).toMatchObject({delivery_reference:'Comprovante fictício'})
  await asUser(inactive)
  await expect(history(false)).rejects.toThrow('perfil')
  await asUser(sales)
  const orderStatus = () => db.query('select fulfillment_status from public.orders where id=$1',[order])
  expect((await orderStatus()).rows).toEqual([{fulfillment_status:'PARCIAL'}])
  await asUser(production)
  await dispatch(second,1)
  await asUser(admin)
  await receive('2099-04-01','2')
  await expect(reserve(8)).rejects.toThrow('ainda não reservada')
  await reserve(7)
  const remaining = await queue()
  for (const slot of remaining) await dispatch(slot.id,Number(slot.remaining))
  expect((await orderStatus()).rows).toEqual([{fulfillment_status:'EXPEDIDO'}])
  expect((await queue()).some(row => row.id === second)).toBe(false)
  expect((await db.query("select sum(quantity_delta) as total from public.stock_movements where kind='EXPEDICAO'")).rows)
    .toEqual([{total:'-9.000000'}])
  await asUser(sales)
  await db.query('select public.register_billing($1,$2,$3)',[order,JSON.stringify({
    invoice_number:'TEST-SHIP',issued_on:'2025-01-01',amount:'90',installments:[{due_on:'2025-02-01',amount:'90'}],
  }),crypto.randomUUID()])
  expect((await db.query('select public.issue_commercial_document($1)',[order])).rows).toHaveLength(1)
})

test('cadastros operacionais exigem Administração e protegem locais com saldo', async () => {
  const save = async (catalog: string, input: Record<string, unknown>, target: string | null = null, version: number | null = null,
    key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.save_operational_catalog($1,$2,$3,$4,$5) id',[catalog,target,version,JSON.stringify(input),key],
  )).rows[0]!.id
  await asUser(production)
  await expect(save('LOCAL',{label:'TEST-CAD-NO',active:true})).rejects.toThrow('Somente Administração')
  await asUser(admin)
  await expect(save('TABELA',{label:'Teste',active:true})).rejects.toThrow('cadastro')
  const supplierInput = {label:'Fornecedor fictício de cadastro',active:true}
  const key = crypto.randomUUID()
  const supplier = await save('FORNECEDOR',supplierInput,null,null,key)
  expect(await save('FORNECEDOR',supplierInput,null,null,key)).toBe(supplier)
  await expect(save('FORNECEDOR',{...supplierInput,label:supplierInput.label.toUpperCase()})).rejects.toThrow('Já existe')
  const maker = await save('FABRICANTE',{label:'Fabricante fictício de cadastro',active:true})
  const location = await save('LOCAL',{label:'TEST-CAD',active:true})
  const item = await save('INSUMO',{label:'Insumo fictício original',code:'TEST-CAD-MP',unit:'kg',active:true})
  await save('INSUMO',{label:'Insumo fictício revisado',active:true},item,1)
  await expect(save('INSUMO',{label:'Versão antiga',active:true},item,1)).rejects.toThrow('cadastro mudou')
  expect((await db.query('select original_description,commercial_description,base_unit,classification from public.items where id=$1',[item])).rows)
    .toEqual([{original_description:'Insumo fictício original',commercial_description:'Insumo fictício revisado',base_unit:'kg',classification:'INSUMO'}])
  await asUser(production)
  const payload = {item_id:item,supplier_id:supplier,manufacturer_id:maker,location_id:location,
    original_lot:'CAD-TESTE',unit:'kg',quantity:'2',expiry:'DESCONHECIDA',invoice_number:'NF-TESTE'}
  await db.query('select public.receive_stock($1,$2)',[JSON.stringify(payload),crypto.randomUUID()])
  await asUser(admin)
  await expect(save('LOCAL',{label:'TEST-CAD',active:false},location,1)).rejects.toThrow('saldo físico')
  await save('FORNECEDOR',{...supplierInput,active:false},supplier,1)
  expect((await db.query('select active,version from public.suppliers where id=$1',[supplier])).rows)
    .toEqual([{active:false,version:2}])
  await asUser(sales)
  expect((await db.query('select id from public.items where id=$1',[item])).rows).toHaveLength(0)
  await expect(save('INSUMO',{label:'Teste',code:'X',unit:'kg',active:true})).rejects.toThrow('Somente Administração')
})

test('ficha técnica vincula insumos sem substituir a transcrição ou aprovar a receita', async () => {
  await db.exec('reset role')
  const [refs] = (await db.query<Record<string, string>>(`
    with material as (
      insert into public.items(original_code,original_description,classification,base_unit)
      values ('TEST-REVIEW-MP','Insumo fictício de teste','INSUMO','kg') returning id
    ), recipe as (
      insert into public.recipes(code,name) values ('TEST-REVIEW','Receita fictícia de revisão') returning id
    ), version as (
      insert into public.recipe_versions(recipe_id,version,yield_min,yield_target,yield_max)
      select id,1,133,134,135 from recipe returning id
    ), ingredients as (
      insert into public.recipe_ingredients(recipe_version_id,source_name,ordinal,quantity,unit)
      select id,'Farinha de trigo',1,100,'kg' from version
      union all select id,'Água',2,null,'L' from version
      union all select id,'Insumo adicional fictício',3,1,'kg' from version returning id,ordinal
    )
    select material.id material_id,version.id version_id,
      (select id from ingredients where ordinal=1) flour_id,(select id from ingredients where ordinal=2) water_id,
      (select id from ingredients where ordinal=3) extra_id
    from material,version
  `)).rows
  const payload = { yield_target:'132.5', storage_conditions:'Referência fictícia', water_control_reference:'', ingredients:[
    { source_ingredient_id:refs!.flour_id,item_id:refs!.material_id,quantity:'99.25',unit:'kg',
      stage:'PREPARACAO',lower_tolerance:'0.1',upper_tolerance:'0.2',technical_reference:'Ficha de teste' },
    { source_ingredient_id:refs!.water_id,item_id:null,quantity:'',unit:'L' },
    { source_ingredient_id:refs!.extra_id,item_id:refs!.material_id,quantity:'1',unit:'kg',
      stage:'BATER_MASSA',lower_tolerance:'0',upper_tolerance:'0' },
  ] }
  const save = async (input: Record<string, unknown> = payload, version: number | null = null, key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.save_recipe_review($1,$2,$3,$4) id',[refs!.version_id,version,JSON.stringify(input),key],
  )).rows[0]!.id
  await asUser(production)
  await expect(save()).rejects.toThrow('Somente Administração')
  await asUser(admin)
  const key = crypto.randomUUID()
  expect(await save(payload,null,key)).toBe(refs!.version_id)
  expect(await save(payload,null,key)).toBe(refs!.version_id)
  await expect(save()).rejects.toThrow('ficha mudou')
  await expect(save({...payload,ingredients:[{...payload.ingredients[0]!,unit:'L'},...payload.ingredients.slice(1)]},1))
    .rejects.toThrow('unidade compatível')
  expect((await db.query('select edit_version from public.recipe_reviews where recipe_version_id=$1',[refs!.version_id])).rows)
    .toEqual([{edit_version:1}])
  await save({...payload,water_control_reference:'Controle fictício'},1)
  await asUser(production)
  expect((await db.query('select quantity,stage from public.recipe_review_ingredients where source_ingredient_id=$1',[refs!.flour_id])).rows)
    .toEqual([{quantity:'99.250000',stage:'PREPARACAO'}])
  expect((await db.query('select quantity from public.recipe_ingredients where id=$1',[refs!.flour_id])).rows)
    .toEqual([{quantity:'100.000000'}])
  expect((await db.query('select yield_target,status from public.recipe_versions where id=$1',[refs!.version_id])).rows)
    .toEqual([{yield_target:'134.000000',status:'PENDENTE_VALIDACAO'}])
  const approve = (version: number, key = crypto.randomUUID()) => db.query(
    'select public.approve_recipe_version($1,$2,$3,$4)',[refs!.version_id,version,'Aprovação fictícia',key],
  )
  await asUser(admin)
  await expect(approve(2)).rejects.toThrow('responsável técnico')
  await db.exec('reset role')
  await db.query('update public.profiles set can_approve_recipe=true where id=$1',[production])
  await asUser(production)
  await expect(approve(2)).rejects.toThrow('Complete rendimento')
  await asUser(admin)
  const complete = {
    ...payload, yield_min:'130',yield_max:'135',shelf_life_days:'3',
    water_control_reference:'Controle de teste', review_reference:'Revisão de teste',
    ingredients:[payload.ingredients[0]!,{...payload.ingredients[1]!,quantity:'20',stage:'BATER_MASSA',
      lower_tolerance:'0',upper_tolerance:'0'},payload.ingredients[2]!],
  }
  await save(complete,2)
  await asUser(production)
  await expect(approve(2)).rejects.toThrow('ficha mudou')
  const approvalKey = crypto.randomUUID()
  await approve(3,approvalKey)
  await approve(3,approvalKey)
  expect((await db.query('select status,yield_target from public.recipe_versions where id=$1',[refs!.version_id])).rows)
    .toEqual([{status:'APROVADA',yield_target:'134.000000'}])
  expect((await db.query('select approved_by,review_version from public.recipe_approvals where recipe_version_id=$1',[refs!.version_id])).rows)
    .toEqual([{approved_by:production,review_version:3}])
  await asUser(admin)
  await expect(save(payload,3)).rejects.toThrow('pendente')
  await db.exec('reset role')
  await expect(db.query('update public.recipe_reviews set shelf_life_days=5 where recipe_version_id=$1',
    [refs!.version_id])).rejects.toThrow('imutável')
  const [orderRefs] = (await db.query<Record<string,string>>(`
    with customer as (
      insert into public.customers(kind,legal_name,created_by,updated_by)
      values ('PJ','Cliente fictício da OP',$1,$1) returning id
    ), item as (
      insert into public.items(original_code,original_description,classification,base_unit)
      values ('TEST-PROD-ORDER','Produto próprio fictício da OP','FABRICACAO_PROPRIA','un') returning id
    )
    select customer.id customer_id,item.id item_id from customer,item
  `,[admin])).rows
  await asUser(admin)
  await db.query("select public.configure_item_units($1,1,'un',1,$2,$3)",
    [orderRefs!.item_id,'Conversão fictícia',crypto.randomUUID()])
  const input = {customer_id:orderRefs!.customer_id,delivery_date:'2099-02-03',
    items:[{item_id:orderRefs!.item_id,unit:'un',quantity:'800',unit_price:'1'}]}
  const purchase = (await db.query<{ id: string }>('select public.create_order_draft($1,$2) id',
    [JSON.stringify(input),crypto.randomUUID()])).rows[0]!.id
  await db.query('select public.confirm_order($1,1,$2)',[purchase,crypto.randomUUID()])
  const demand = (await db.query<{ order_item_id: string }>('select order_item_id from public.production_demands where order_id=$1',
    [purchase])).rows[0]!.order_item_id
  const association = (await db.query<{ id: string }>(
    "select public.save_recipe_assignment($1,$2,'CLIENTE',$3,null,$4,$5) id",
    [orderRefs!.item_id,orderRefs!.customer_id,refs!.version_id,'Associação fictícia',crypto.randomUUID()],
  )).rows[0]!.id
  const createPlan = async (rule = association, key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    "select public.create_production_order($1,$2,'MEDIO',$3,$4) id",
    [demand,rule,'Planejamento fictício',key],
  )).rows[0]!.id
  await asUser(production)
  await expect(createPlan(crypto.randomUUID())).rejects.toThrow('associação vigente mudou')
  const planKey = crypto.randomUUID()
  const planned = await createPlan(association,planKey)
  expect(await createPlan(association,planKey)).toBe(planned)
  await expect(createPlan()).rejects.toThrow('já tem uma ordem')
  const [plan] = (await db.query(
    'select status,yield_kg,batches_count,recipe_snapshot from public.production_orders where id=$1',[planned],
  )).rows
  expect(plan).toMatchObject({status:'PLANEJADA',yield_kg:'132.500000',batches_count:7,recipe_snapshot:{
    review_version:3,shelf_life_days:3,ingredients:[
      expect.objectContaining({item_id:refs!.material_id,quantity:'99.250000'}),
      expect.objectContaining({name:'Água',quantity:'20.000000'}),
      expect.objectContaining({name:'Insumo adicional fictício',quantity:'1.000000'}),
    ],
  }})
  expect((await db.query<{ sequence: number }>(
    'select sequence from public.production_batches where production_order_id=$1 order by sequence',[planned],
  )).rows.map(row => row.sequence)).toEqual([1,2,3,4,5,6,7])
  const batchIds = (await db.query<{ id: string }>(
    'select id from public.production_batches where production_order_id=$1 order by sequence limit 2',[planned],
  )).rows
  const startBatch = async (batch: string, version=1, key=crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.start_batch($1,$2,$3) id',[batch,version,key],
  )).rows[0]!.id
  await expect(startBatch(batchIds[0]!.id)).rejects.toThrow('saldo elegível')
  await db.exec('reset role')
  await db.query('update public.profiles set can_release_lot=true where id=$1',[admin])
  const [stock] = (await db.query<Record<string,string>>(`
    with supplier as (
      insert into public.suppliers(name) values ('Fornecedor fictício em preparação') returning id
    ), maker as (
      insert into public.manufacturers(name) values ('Fabricante fictício em preparação') returning id
    ), location as (
      insert into public.locations(code) values ('TEST-PREP') returning id
    )
    select supplier.id supplier_id,maker.id manufacturer_id,location.id location_id from supplier,maker,location
  `)).rows
  await asUser(admin)
  const receipt = { ...stock,item_id:refs!.material_id,original_lot:'PREP-TEST',unit:'kg',quantity:'200',
    expiry:'INFORMADA',expires_on:'2099-03-01',invoice_number:'PREP-TEST' }
  const materialLot = (await db.query<{ id: string }>('select public.receive_stock($1,$2) id',
    [JSON.stringify(receipt),crypto.randomUUID()])).rows[0]!.id
  await db.query("select public.decide_inventory_lot($1,1,'LIBERADO',$2,$3)",
    [materialLot,'Liberação fictícia',crypto.randomUUID()])
  await asUser(production)
  await expect(startBatch(batchIds[0]!.id,0)).rejects.toThrow('massada mudou')
  const startKey = crypto.randomUUID()
  expect(await startBatch(batchIds[0]!.id,1,startKey)).toBe(batchIds[0]!.id)
  expect(await startBatch(batchIds[0]!.id,1,startKey)).toBe(batchIds[0]!.id)
  await startBatch(batchIds[1]!.id)
  const started = (await db.query<{ lot_code: string; status: string }>(
    'select lot_code,status from public.production_batches where production_order_id=$1 and started_at is not null order by sequence',[planned],
  )).rows
  expect(started).toHaveLength(2)
  expect(started.every(row => /^SP-[0-9]{8}-[0-9]{4}$/.test(row.lot_code) && row.status === 'EM_PREPARACAO')).toBe(true)
  expect(started[0]!.lot_code).not.toBe(started[1]!.lot_code)
  expect((await db.query('select stage,status from public.production_batch_stages where batch_id=$1',[batchIds[0]!.id])).rows)
    .toEqual([{stage:'PREPARACAO',status:'EM_EXECUCAO'}])
  expect((await db.query('select quantity from public.stock_balances where lot_id=$1',[materialLot])).rows)
    .toEqual([{quantity:'200.000000'}])
  await asUser(admin)
  const earlyLot = (await db.query<{ id: string }>('select public.receive_stock($1,$2) id',
    [JSON.stringify({...receipt,original_lot:'PREP-TEST-FEFO',quantity:'30',expires_on:'2099-02-01'}),crypto.randomUUID()])).rows[0]!.id
  await db.query("select public.decide_inventory_lot($1,1,'LIBERADO',$2,$3)",
    [earlyLot,'Liberação fictícia',crypto.randomUUID()])
  await asUser(production)
  const preview = async (amount: string) => (await db.query<{ lots: Record<string,unknown>[] }>(
    'select public.preview_preparation_ingredient($1,$2,$3) lots',[batchIds[0]!.id,refs!.flour_id,amount],
  )).rows[0]!.lots
  await expect(preview('102')).rejects.toThrow('fora da tolerância')
  const suggestion = await preview('99.25')
  expect(suggestion).toMatchObject([{lot_id:earlyLot,quantity:'30.000000'},{lot_id:materialLot,quantity:'69.250000'}])
  const completeStage = (version: number, key=crypto.randomUUID()) => db.query(
    'select public.complete_preparation($1,$2,$3)',[batchIds[0]!.id,version,key],
  )
  const recordWater = (version: number, amount='20', key=crypto.randomUUID()) => db.query(
    'select public.record_batch_water($1,$2,$3,$4,$5,$6,$7)',
    [batchIds[0]!.id,refs!.water_id,version,amount,'Origem fictícia','Controle fictício',key],
  )
  await expect(completeStage(2)).rejects.toThrow('todos os apontamentos')
  await expect(recordWater(2)).rejects.toThrow('etapa atual')
  const consume = async (allocation: Record<string,unknown>[], version=2, key=crypto.randomUUID()) =>
    (await db.query<{ id: string }>('select public.confirm_preparation_ingredient($1,$2,$3,$4,$5,$6) id',
      [batchIds[0]!.id,refs!.flour_id,version,'99.25',JSON.stringify(allocation),key])).rows[0]!.id
  await expect(consume(suggestion.slice(1))).rejects.toThrow('lotes FEFO mudaram')
  expect((await db.query('select id from public.batch_ingredient_consumptions where batch_id=$1',[batchIds[0]!.id])).rows).toHaveLength(0)
  const weighKey = crypto.randomUUID()
  const consumption = await consume(suggestion,2,weighKey)
  expect(await consume(suggestion,2,weighKey)).toBe(consumption)
  await expect(consume(suggestion,3)).rejects.toThrow('já foi apontado')
  expect((await db.query('select quantity from public.stock_balances where lot_id=$1',[materialLot])).rows)
    .toEqual([{quantity:'130.750000'}])
  expect((await db.query('select lot_id,quantity from public.batch_ingredient_consumption_lots where consumption_id=$1 order by quantity',
    [consumption])).rows).toEqual([{lot_id:earlyLot,quantity:'30.000000'},{lot_id:materialLot,quantity:'69.250000'}])
  expect((await db.query('select public.preparation_checklist($1) data',[batchIds[0]!.id])).rows)
    .toMatchObject([{data:{version:3,items:[{name:'Farinha de trigo',consumed:'99.250000'}]}}])
  const stageKey=crypto.randomUUID()
  await completeStage(3,stageKey)
  await completeStage(3,stageKey)
  expect((await db.query('select stage,status from public.production_batch_stages where batch_id=$1 order by started_at',
    [batchIds[0]!.id])).rows).toEqual([
    {stage:'PREPARACAO',status:'CONCLUIDA'},{stage:'BATER_MASSA',status:'EM_EXECUCAO'},
  ])
  expect((await db.query('select public.production_stage_checklist($1) data',[batchIds[0]!.id])).rows)
    .toMatchObject([{data:{version:4,stage:'BATER_MASSA',prepared_lots:[
      {name:'Farinha de trigo'},{name:'Farinha de trigo'},
    ]}}])
  const finish = (stage: string, version: number, mass: string | null, key=crypto.randomUUID()) => db.query(
    'select public.complete_production_stage($1,$2,$3,$4,$5,$6)',
    [batchIds[0]!.id,version,stage,mass,'Observação fictícia',key],
  )
  await expect(finish('CILINDROS',4,null)).rejects.toThrow('não está na etapa')
  await expect(finish('BATER_MASSA',4,null)).rejects.toThrow('incorporação')
  const handoffKey=crypto.randomUUID()
  await db.query('select public.confirm_prepared_ingredients($1,4,$2)',[batchIds[0]!.id,handoffKey])
  await expect(finish('BATER_MASSA',5,null)).rejects.toThrow('todos os apontamentos')
  await db.query('select public.confirm_prepared_ingredients($1,4,$2)',[batchIds[0]!.id,handoffKey])
  await expect(recordWater(5,'21')).rejects.toThrow('controle da água')
  const waterKey=crypto.randomUUID()
  await recordWater(5,'20',waterKey)
  await recordWater(5,'20',waterKey)
  expect((await db.query('select quantity from public.stock_balances where lot_id=$1',[materialLot])).rows)
    .toEqual([{quantity:'130.750000'}])
  const extraPreview = (await db.query<{ lots: Record<string,unknown>[] }>(
    'select public.preview_preparation_ingredient($1,$2,1) lots',[batchIds[0]!.id,refs!.extra_id],
  )).rows[0]!.lots
  await db.query('select public.confirm_preparation_ingredient($1,$2,6,1,$3,$4)',
    [batchIds[0]!.id,refs!.extra_id,JSON.stringify(extraPreview),crypto.randomUUID()])
  expect((await db.query('select kind,quantity_delta from public.stock_movements where lot_id=$1 and kind=$2',
    [materialLot,'CONSUMO_BATER_MASSA'])).rows).toEqual([{kind:'CONSUMO_BATER_MASSA',quantity_delta:'-1.000000'}])
  expect((await db.query('select quantity,stage from public.batch_water_records where batch_id=$1',
    [batchIds[0]!.id])).rows).toEqual([{quantity:'20.000000',stage:'BATER_MASSA'}])
  await expect(finish('BATER_MASSA',7,'-1')).rejects.toThrow('peso medido')
  const mixingKey=crypto.randomUUID()
  await finish('BATER_MASSA',7,'120.25',mixingKey)
  await finish('BATER_MASSA',7,'120.25',mixingKey)
  await finish('CILINDROS',8,null)
  expect((await db.query('select stage,status,measured_kg,completion_notes from public.production_batch_stages where batch_id=$1 order by started_at',
    [batchIds[0]!.id])).rows).toEqual([
    {stage:'PREPARACAO',status:'CONCLUIDA',measured_kg:null,completion_notes:null},
    {stage:'BATER_MASSA',status:'CONCLUIDA',measured_kg:'120.250000',completion_notes:'Observação fictícia'},
    {stage:'CILINDROS',status:'CONCLUIDA',measured_kg:null,completion_notes:'Observação fictícia'},
    {stage:'EMBALAGEM',status:'EM_EXECUCAO',measured_kg:null,completion_notes:null},
  ])
  await asUser(sales)
  await expect(finish('CILINDROS',9,null)).rejects.toThrow('perfil')
  await expect(preview('99.25')).rejects.toThrow('perfil')
  await expect(consume(suggestion,3)).rejects.toThrow('perfil')
  expect((await db.query('select id from public.batch_ingredient_consumptions')).rows).toHaveLength(0)
  await expect(startBatch(batchIds[0]!.id)).rejects.toThrow('perfil')
  const [board] = (await db.query<{ report: { rows: Record<string,unknown>[] } }>(
    'select public.production_board(100,0) report',
  )).rows
  expect(board!.report.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({id:batchIds[0]!.id,status:'EM_EMBALAGEM',operator:null,stage_started_at:expect.any(String)}),
  ]))
  expect(board!.report.rows.every(row => !('recipe_snapshot' in row))).toBe(true)
  const columns = async (offsets = {}, search = '') => (await db.query<{
    report: Record<string, { total: number; rows: Record<string, unknown>[] }>
  }>('select public.production_board_columns(1,$1,$2) report', [JSON.stringify(offsets), search])).rows[0]!.report
  const firstColumns = await columns()
  expect(Object.keys(firstColumns)).toHaveLength(6)
  expect(firstColumns.EM_EMBALAGEM!.rows).toEqual([
    expect.objectContaining({id:batchIds[0]!.id,status:'EM_EMBALAGEM',operator:null}),
  ])
  const nextPackingPage = await columns({EM_EMBALAGEM: 1})
  expect(nextPackingPage.EM_EMBALAGEM).toMatchObject({total:1,rows:[]})
  expect(nextPackingPage.PLANEJADA).toEqual(firstColumns.PLANEJADA)
  expect((await columns({}, 'termo sem correspondência')).EM_EMBALAGEM).toEqual({total:0,rows:[]})
  await expect(columns({EM_EMBALAGEM: -1})).rejects.toThrow('paginação')
  await asUser(inactive)
  await expect(columns()).rejects.toThrow('perfil')
  await db.exec('reset role')
  const packingItems = (await db.query<{ id: string; original_code: string }>(`
    insert into public.items(original_code,original_description,classification,base_unit) values
      ('TEST-PACK-EMB','Embalagem fictícia','INSUMO','un'),('TEST-PACK-ETQ','Etiqueta fictícia','INSUMO','un')
    returning id,original_code
  `)).rows
  await asUser(admin)
  const configInput = {manufacturer_id:stock!.manufacturer_id,package_item_id:packingItems[0]!.id,
    label_item_id:packingItems[1]!.id,packages_per_unit:'1',labels_per_unit:'1',reference:'Configuração fictícia'}
  const config = (await db.query<{ id: string }>('select public.save_packaging_config($1,null,$2,$3) id',
    [orderRefs!.item_id,JSON.stringify(configInput),crypto.randomUUID()])).rows[0]!.id
  for (const item of packingItems) {
    const packLot = (await db.query<{ id: string }>('select public.receive_stock($1,$2) id',
      [JSON.stringify({...receipt,item_id:item.id,original_lot:item.original_code,unit:'un'}),crypto.randomUUID()])).rows[0]!.id
    await db.query("select public.decide_inventory_lot($1,1,'LIBERADO',$2,$3)",
      [packLot,'Liberação fictícia',crypto.randomUUID()])
  }
  const packInput = {units:'100',actual_kg:'100.5',package_rejected:'2',label_rejected:'1',output_location_id:stock!.location_id}
  const previewPack = async (input = packInput) => (await db.query<{ data: Record<string,unknown> }>(
    'select public.preview_batch_packaging($1,$2) data',[batchIds[0]!.id,JSON.stringify(input)],
  )).rows[0]!.data
  await asUser(production)
  await expect(previewPack({...packInput,units:'150'})).rejects.toThrow('massa disponível')
  const packing = await previewPack()
  expect(packing).toMatchObject({config_id:config,available_kg:'120.250000',packages:[{quantity:'102.000000'}],
    labels:[{quantity:'101.000000'}]})
  const finishPack = async (preview = packing, key=crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.complete_batch_packaging($1,$2,$3,$4) id',
    [batchIds[0]!.id,JSON.stringify(packInput),JSON.stringify(preview),key],
  )).rows[0]!.id
  await expect(finishPack({...packing,labels:[]})).rejects.toThrow('Revise a sugestão')
  expect((await db.query('select id from public.inventory_lots where production_batch_id=$1',[batchIds[0]!.id])).rows).toHaveLength(0)
  const packKey=crypto.randomUUID()
  const finishedLot=await finishPack(packing,packKey)
  expect(await finishPack(packing,packKey)).toBe(finishedLot)
  expect((await db.query('select status,expires_on-manufactured_on as term from public.inventory_lots where id=$1',[finishedLot])).rows)
    .toEqual([{status:'QUARENTENA',term:3}])
  expect((await db.query('select quantity from public.stock_balances where lot_id=$1',[finishedLot])).rows)
    .toEqual([{quantity:'100.000000'}])
  expect((await db.query('select public.request_inventory_label($1,$2) label',[finishedLot,crypto.randomUUID()])).rows)
    .toMatchObject([{label:{document_type:'Ordem de produção',initial_quantity:'100.000000'}}])
  expect((await db.query("select quantity_delta from public.stock_movements where kind='CONSUMO_EMBALAGEM' and correlation_id=$1 order by quantity_delta",
    [batchIds[0]!.id])).rows).toEqual([{quantity_delta:'-102.000000'},{quantity_delta:'-101.000000'}])
  expect((await db.query('select status from public.production_batches where id=$1',[batchIds[0]!.id])).rows)
    .toEqual([{status:'FINALIZADA'}])
  expect((await db.query('select status from public.production_orders where id=$1',[planned])).rows)
    .toEqual([{status:'EM_PRODUCAO'}])
  await db.exec('reset role')
  const otherClient = (await db.query<{ id: string }>(`
    insert into public.customers(kind,legal_name,created_by,updated_by)
    values('PJ','Cliente sem autorização para lote reservado',$1,$1) returning id
  `,[admin])).rows[0]!.id
  await asUser(admin)
  await db.query("select public.save_recipe_assignment($1,null,'PADRAO',$2,null,$3,$4)",
    [orderRefs!.item_id,refs!.version_id,'Padrão fictício',crypto.randomUUID()])
  const today = (await db.query<{ local_day: string }>(
    "select ((statement_timestamp() at time zone 'America/Sao_Paulo')::date)::text local_day",
  )).rows[0]!.local_day
  const orderFor = async (customerId: string) => {
    const draft = (await db.query<{ id: string }>('select public.create_order_draft($1,$2) id',
      [JSON.stringify({...input,customer_id:customerId,delivery_date:today,items:[{...input.items[0]!,quantity:'150'}]}),crypto.randomUUID()])).rows[0]!.id
    await db.query('select public.confirm_order($1,1,$2)',[draft,crypto.randomUUID()])
    return (await db.query<{ id: string }>('select id from public.order_items where order_id=$1',[draft])).rows[0]!.id
  }
  const target = await orderFor(orderRefs!.customer_id!)
  const unrelated = await orderFor(otherClient)
  const reserveFinished = async (line: string) => (await db.query<{ id: string }>(
    'select public.reserve_order_stock($1,30,$2) id',[line,crypto.randomUUID()],
  )).rows[0]!.id
  await expect(reserveFinished(target)).rejects.toThrow('Saldo elegível insuficiente')
  await db.query("select public.decide_inventory_lot($1,1,'LIBERADO',$2,$3)",
    [finishedLot,'Liberação fictícia do acabado',crypto.randomUUID()])
  await expect(reserveFinished(unrelated)).rejects.toThrow('Saldo elegível insuficiente')
  const finishedReservation = await reserveFinished(target)
  expect((await db.query('select lot_id,recipe_version_id,packaging_config_id from public.stock_reservations where id=$1',
    [finishedReservation])).rows).toEqual([{lot_id:finishedLot,recipe_version_id:refs!.version_id,packaging_config_id:config}])
  await asUser(production)
  const coverage = async () => Number((await db.query<{ kg: string }>(
    'select public.demand_stock_coverage($1) kg',[target],
  )).rows[0]!.kg)
  expect(await coverage()).toBe(30)
  await db.query("select public.confirm_shipment($1,20,'ENTREGA',null,$2)",[finishedReservation,crypto.randomUUID()])
  expect(await coverage()).toBe(30)
  await asUser(admin)
  await db.query('select public.release_stock_reservation($1,$2,$3)',
    [finishedReservation,'Liberação fictícia do restante',crypto.randomUUID()])
  expect(await coverage()).toBe(20)
  const netPlan = (await db.query<{ id: string }>(
    "select public.create_production_order($1,$2,'MEDIO',$3,$4) id",
    [target,association,'Plano fictício líquido',crypto.randomUUID()],
  )).rows[0]!.id
  expect((await db.query('select target_kg,batches_count from public.production_orders where id=$1',[netPlan])).rows)
    .toEqual([{target_kg:'130.000000000',batches_count:1}])
  const codes = (await db.query<{ id: string; internal_code: string }>(
    'select id,internal_code from public.inventory_lots where id in ($1,$2)',[finishedLot,earlyLot],
  )).rows
  const finishedCode = codes.find(row=>row.id===finishedLot)!.internal_code
  const ingredientCode = codes.find(row=>row.id===earlyLot)!.internal_code
  const genealogy = async (code: string) => (await db.query<{
    trace: { production: { batches: unknown[]; inputs: unknown[]; uses: unknown[]; water: unknown[]; destinations: unknown[] } }
  }>('select public.trace_inventory_lot($1) trace',[code])).rows[0]!.trace.production
  await asUser(production)
  const backward = await genealogy(finishedCode)
  expect(backward.batches).toEqual([expect.objectContaining({
    id:batchIds[0]!.id,output_code:finishedCode,output_units:'100.000000',output_status:'LIBERADO',
  })])
  expect(backward.inputs).toEqual(expect.arrayContaining([
    expect.objectContaining({kind:'INGREDIENTE',source_code:ingredientCode,quantity:'30.000000',
      invoice_number:'PREP-TEST',supplier:'Fornecedor fictício em preparação'}),
    expect.objectContaining({kind:'EMBALAGEM',quantity:'102.000000'}),
    expect.objectContaining({kind:'ETIQUETA',quantity:'101.000000'}),
  ]))
  expect(backward.water).toEqual([expect.objectContaining({source:'Origem fictícia',quantity:'20.000000'})])
  const forward = await genealogy(ingredientCode)
  expect(forward.inputs).toEqual([])
  expect(forward.uses).toEqual([expect.objectContaining({source_code:ingredientCode,batch_id:batchIds[0]!.id})])
  expect(forward.batches).toEqual(backward.batches)
  expect(forward.destinations).toEqual([expect.objectContaining({
    output_code:finishedCode,customer_name:'Cliente fictício da OP',quantity:'20.000000',
  })])
  const secondBatch = batchIds[1]!.id
  const secondWeigh = (await db.query<{ lots: Record<string,unknown>[] }>(
    'select public.preview_preparation_ingredient($1,$2,99.25) lots',[secondBatch,refs!.flour_id],
  )).rows[0]!.lots
  await db.query('select public.confirm_preparation_ingredient($1,$2,2,99.25,$3,$4)',
    [secondBatch,refs!.flour_id,JSON.stringify(secondWeigh),crypto.randomUUID()])
  const rootCode = (await db.query<{ internal_code: string }>(
    'select internal_code from public.inventory_lots where id=$1',[materialLot],
  )).rows[0]!.internal_code
  const openRecall = async (key=crypto.randomUUID()) => (await db.query<{ id:string }>(
    'select public.open_lot_recall($1,$2,$3) id',[rootCode,'Motivo fictício de recolhimento',key],
  )).rows[0]!.id
  await expect(openRecall()).rejects.toThrow('Somente Administração')
  await asUser(admin)
  const openReservation = await reserveFinished(target)
  const recallKey=crypto.randomUUID()
  const recall = await openRecall(recallKey)
  expect(await openRecall(recallKey)).toBe(recall)
  await expect(openRecall()).rejects.toThrow('Já existe')
  const details = async () => (await db.query<{ data: {
    lots: unknown[]; batches: unknown[]; shipments: { id:string }[]; actions: unknown[]
  } }>('select public.lot_recall_details($1) data',[recall])).rows[0]!.data
  const report = await details()
  expect(report.lots).toEqual(expect.arrayContaining([
    expect.objectContaining({code:rootCode,status:'BLOQUEADO'}),
    expect.objectContaining({code:finishedCode,status:'BLOQUEADO'}),
  ]))
  expect(report.batches).toEqual(expect.arrayContaining([
    expect.objectContaining({status:'FINALIZADA'}),expect.objectContaining({status:'EM_PREPARACAO'}),
  ]))
  expect(report.shipments).toEqual([expect.objectContaining({customer:'Cliente fictício da OP',quantity:'20.000000'})])
  await expect(db.query("select public.decide_inventory_lot($1,3,'LIBERADO',$2,$3)",
    [finishedLot,'Liberação fictícia',crypto.randomUUID()])).rejects.toThrow('recolhimento ativo')
  await asUser(production)
  const advanceRecalled = () => db.query('select public.complete_preparation($1,3,$2)',
    [secondBatch,crypto.randomUUID()])
  await expect(advanceRecalled()).rejects.toThrow('recolhimento sem autorização')
  await expect(db.query("select public.confirm_shipment($1,1,'ENTREGA',null,$2)",
    [openReservation,crypto.randomUUID()])).rejects.toThrow('lote não está elegível')
  const affectedShipment = report.shipments[0]!.id
  await db.query('select public.record_recall_action($1,$2,$3,$4)',
    [recall,affectedShipment,'Contato fictício registrado',crypto.randomUUID()])
  await db.query('select public.register_shipment_return($1,$2,1,$3,$4)',
    [affectedShipment,stock!.location_id,'Recebimento fictício',crypto.randomUUID()])
  expect((await details()).lots).toEqual(expect.arrayContaining([expect.objectContaining({status:'QUARENTENA',physical:'1.000000'})]))
  expect((await details()).actions).toEqual([expect.objectContaining({shipment_id:affectedShipment,note:'Contato fictício registrado'})])
  const close = (id=recall,key=crypto.randomUUID()) => db.query(
    'select public.close_lot_recall($1,$2,$3)',[id,'Avaliação sanitária fictícia',key],
  )
  const resume = (key=crypto.randomUUID()) => db.query(
    'select public.authorize_recall_batch_resume($1,$2,$3,$4)',[recall,secondBatch,'Retomada fictícia avaliada',key],
  )
  await expect(close()).rejects.toThrow('autorização sanitária')
  await asUser(admin)
  await expect(resume()).rejects.toThrow('Encerre todos os casos ativos')
  const overlappingRecall = (await db.query<{ id:string }>(
    'select public.open_lot_recall($1,$2,$3) id',[ingredientCode,'Caso fictício sobreposto',crypto.randomUUID()],
  )).rows[0]!.id
  const closeKey=crypto.randomUUID()
  await close(recall,closeKey)
  await close(recall,closeKey)
  expect(await details()).toMatchObject({closed_at:expect.any(String),close_reference:'Avaliação sanitária fictícia'})
  const releaseFinished = () => db.query("select public.decide_inventory_lot($1,3,'LIBERADO',$2,$3)",
    [finishedLot,'Liberação fictícia avaliada',crypto.randomUUID()])
  await expect(releaseFinished()).rejects.toThrow('recolhimento ativo')
  await close(overlappingRecall)
  expect((await db.query('select status from public.inventory_lots where id=$1',[finishedLot])).rows)
    .toEqual([{status:'BLOQUEADO'}])
  await releaseFinished()
  await asUser(production)
  await expect(advanceRecalled()).rejects.toThrow('sem autorização')
  await asUser(admin)
  const resumeKey=crypto.randomUUID()
  await resume(resumeKey)
  await resume(resumeKey)
  await asUser(production)
  await advanceRecalled()
  expect((await details()).batches).toEqual(expect.arrayContaining([
    expect.objectContaining({id:secondBatch,status:'EM_BATER_MASSA',resume_authorized_at:expect.any(String)}),
  ]))
  const controlPause = (version: number, pause: boolean, reason: string | null, key=crypto.randomUUID()) => db.query(
    'select public.change_production_stage_pause($1,$2,$3,$4,$5)',[secondBatch,version,pause,reason,key],
  )
  await expect(controlPause(4,true,'')).rejects.toThrow('motivo')
  const pauseKey=crypto.randomUUID()
  await controlPause(4,true,'Interrupção fictícia',pauseKey)
  await controlPause(4,true,'Interrupção fictícia',pauseKey)
  await expect(controlPause(4,false,null)).rejects.toThrow('massada mudou')
  await expect(db.query('select public.record_batch_water($1,$2,5,20,$3,$4,$5)',
    [secondBatch,refs!.water_id,'Origem fictícia','Controle fictício',crypto.randomUUID()])).rejects.toThrow('Retome a etapa')
  expect((await db.query('select id from public.batch_water_records where batch_id=$1',[secondBatch])).rows).toHaveLength(0)
  await db.exec('reset role')
  await db.query("update public.production_batch_stages set started_at=statement_timestamp()-interval '10 minutes' where batch_id=$1 and stage='BATER_MASSA'",
    [secondBatch])
  await db.query("update public.production_stage_pauses set paused_at=(select started_at+interval '120 seconds' from public.production_batch_stages where batch_id=$1 and stage='BATER_MASSA') where batch_id=$1",
    [secondBatch])
  await asUser(production)
  const timing = async () => (await db.query<{ timings: Record<string,unknown>[] }>(
    'select public.production_stage_times($1) timings',[secondBatch],
  )).rows[0]!.timings.find(row => row.stage==='BATER_MASSA')
  expect(await timing()).toMatchObject({status:'PAUSADA',net_seconds:120,pauses:[
    expect.objectContaining({reason:'Interrupção fictícia',resumed_at:null}),
  ]})
  const resumePauseKey=crypto.randomUUID()
  await controlPause(5,false,null,resumePauseKey)
  await controlPause(5,false,null,resumePauseKey)
  expect(await timing()).toMatchObject({status:'EM_EXECUCAO',pauses:[
    expect.objectContaining({resumed_at:expect.any(String)}),
  ]})
  expect((await db.query('select paused_by,resumed_by from public.production_stage_pauses where batch_id=$1',[secondBatch])).rows)
    .toEqual([{paused_by:production,resumed_by:production}])
  const addDestination = () => db.query<{ id:string }>(
    "select public.add_loss_option('DESTINACAO',$1,$2,$3) id",
    ['Destinação fictícia de teste','Autorização fictícia',crypto.randomUUID()],
  )
  await expect(addDestination()).rejects.toThrow('Somente Administração')
  await asUser(admin)
  const destination = (await addDestination()).rows[0]!.id
  const cause = (await db.query<{ id:string }>("select id from public.loss_reasons where name='Mistura'")).rows[0]!.id
  const recordLoss = async (input: Record<string,unknown>, key=crypto.randomUUID()) => (await db.query<{id:string}>(
    'select public.record_mass_loss($1,$2) id',[JSON.stringify({reason_id:cause,destination_id:destination,...input}),key],
  )).rows[0]!.id
  await asUser(production)
  const countMovements = async () => (await db.query('select count(*) from public.stock_movements')).rows
  const beforeLosses = await countMovements()
  await expect(recordLoss({batch_id:secondBatch,operation:'PREPARACAO',quantity_kg:'2.5'})).rejects.toThrow('etapa em execução')
  const payloadLoss = {batch_id:secondBatch,operation:'BATER_MASSA',quantity_kg:'2.5'}
  const lossKey=crypto.randomUUID()
  const linkedLoss=await recordLoss(payloadLoss,lossKey)
  expect(await recordLoss(payloadLoss,lossKey)).toBe(linkedLoss)
  const unlinkedLoss=await recordLoss({operation:'OUTRA',quantity_kg:'1.25'})
  const reconcile = (key=crypto.randomUUID()) => db.query(
    "select public.reconcile_mass_loss($1,$2,'BATER_MASSA',$3,$4)",
    [unlinkedLoss,secondBatch,'Conciliação fictícia',key],
  )
  const losses = async () => (await db.query<{report:{total:number;total_kg:string;rows:Record<string,unknown>[];causes:unknown[]}}>(
    'select public.mass_loss_history($1,$1,$2,1,0) report',[today,cause],
  )).rows[0]!.report
  expect(await losses()).toMatchObject({total:2,total_kg:'3.750000',causes:[{reason:'Mistura',quantity:'3.750000'}]})
  expect((await losses()).rows).toHaveLength(1)
  await expect(reconcile()).rejects.toThrow('Somente Administração')
  await asUser(admin)
  const reconcileKey=crypto.randomUUID()
  await reconcile(reconcileKey)
  await reconcile(reconcileKey)
  expect((await db.query('select batch_id,operation from public.production_losses where id=$1',[unlinkedLoss])).rows)
    .toEqual([{batch_id:secondBatch,operation:'BATER_MASSA'}])
  expect((await losses()).total).toBe(2)
  expect(await countMovements()).toEqual(beforeLosses)
  const discard = async (lotId: string, category: string, quantity: string, key=crypto.randomUUID()) =>
    (await db.query<{ id:string }>('select public.discard_stock($1,$2) id',[JSON.stringify({
      lot_id:lotId,location_id:stock!.location_id,category,quantity,reason_id:cause,destination_id:destination,
    }),key])).rows[0]!.id
  await expect(discard(finishedLot,'VENCIMENTO_ACABADO','1')).rejects.toThrow('validade do lote')
  await expect(discard(finishedLot,'OUTRO_ACABADO','70')).rejects.toThrow('saldo reservado')
  await expect(discard(materialLot,'INSUMO','99')).rejects.toThrow('Saldo físico insuficiente')
  await asUser(production)
  await expect(discard(materialLot,'INSUMO','2')).rejects.toThrow('perfil administrador')
  await asUser(admin)
  const wasteKey=crypto.randomUUID()
  const waste=await discard(materialLot,'INSUMO','2',wasteKey)
  expect(await discard(materialLot,'INSUMO','2',wasteKey)).toBe(waste)
  await discard(finishedLot,'OUTRO_ACABADO','5')
  expect((await db.query('select quantity from public.stock_balances where lot_id=$1',[materialLot])).rows)
    .toEqual([{quantity:'28.500000'}])
  expect((await db.query("select quantity_delta from public.stock_movements where kind='DESCARTE_ESTOQUE' and correlation_id=$1",[waste])).rows)
    .toEqual([{quantity_delta:'-2.000000'}])
  const stockLosses = async () => (await db.query<{ report:Record<string,unknown> }>(
    'select public.stock_waste_history($1,$1,null,1,0) report',[today],
  )).rows[0]!.report
  await asUser(production)
  expect(await stockLosses()).toMatchObject({total:2,totals:[
    {category:'INSUMO',unit:'kg',quantity:'2.000000'},{category:'OUTRO_ACABADO',unit:'un',quantity:'5.000000'},
  ]})
  expect((await losses()).total_kg).toBe('3.750000')
  const dashboard = async (date = today) => (await db.query<{ report:Record<string,unknown> }>(
    'select public.role_dashboard($1,$1) report',[date],
  )).rows[0]!.report
  expect(await dashboard()).toMatchObject({
    commercial:null,
    operations:{finished_count:1,measured_count:1,measured_kg:'100.5',nominal_kg:'100.000000',
      mass_loss_kg:'3.750000',linked_loss_pct:null,
      daily:[{day:today,finished_count:1,measured_count:1,measured_kg:'100.5',loss_kg:'3.750000'}]},
  })
  await expect(dashboard('2999-01-01')).rejects.toThrow('período')
  await asUser(admin)
  expect(await dashboard('2001-01-01')).toMatchObject({
    operations:{finished_count:0,measured_kg:null,mass_loss_kg:null,daily:[]},
    commercial:{otif_eligible:0,otif_pct:null,billing_count:0,billed_amount:null},
  })
  await asUser(sales)
  expect(await dashboard()).toMatchObject({operations:null,commercial:{otif_pct:null}})
  await expect(stockLosses()).rejects.toThrow('perfil')
  expect((await db.query('select id from public.stock_waste_records')).rows).toHaveLength(0)
  await expect(losses()).rejects.toThrow('perfil')
  expect((await db.query('select id from public.production_losses')).rows).toHaveLength(0)
  await expect(timing()).rejects.toThrow('perfil')
  await expect(details()).rejects.toThrow('perfil')
  await expect(genealogy(finishedCode)).rejects.toThrow('perfil')
  await expect(previewPack()).rejects.toThrow('perfil')
  await expect(createPlan()).rejects.toThrow('perfil')
  expect((await db.query('select * from public.production_orders')).rows).toHaveLength(0)
  expect((await db.query('select * from public.recipe_review_ingredients')).rows).toHaveLength(0)
  expect((await db.query('select * from public.recipe_approvals')).rows).toHaveLength(0)
  await expect(save()).rejects.toThrow('Somente Administração')
})

test('a associação por cliente tem prioridade e o padrão só vale quando cadastrado', async () => {
  await db.exec('reset role')
  const [refs] = (await db.query<Record<string, string>>(`
    with customers as (
      insert into public.customers(kind,legal_name,created_by,updated_by)
      values ('PJ','Cliente fictício regra A',$1,$1),('PJ','Cliente fictício regra B',$1,$1) returning id,legal_name
    ), product as (
      insert into public.items(original_code,original_description,classification,base_unit)
      values ('TEST-ASSIGN','Produto de associação fictício','FABRICACAO_PROPRIA','kg') returning id
    ), recipe as (
      insert into public.recipes(code,name) values ('TEST-ASSIGN','Receita fictícia de associação') returning id
    ), versions as (
      insert into public.recipe_versions(recipe_id,version,yield_min,yield_target,yield_max,status)
      select recipe.id,v,133,134,135,case when v < 3 then 'APROVADA' else 'PENDENTE_VALIDACAO' end
      from recipe cross join generate_series(1,3) v returning id,version
    ), approvals as (
      insert into public.recipe_approvals(recipe_version_id,review_version,approved_by,approval_reference)
      select id,1,$1,'Aprovação fictícia' from versions where version < 3
    )
    select product.id item_id,(select id from customers where legal_name like '% A') customer_a,
      (select id from customers where legal_name like '% B') customer_b,
      (select id from versions where version=1) approved_one,(select id from versions where version=2) approved_two,
      (select id from versions where version=3) pending from product
  `,[admin])).rows
  const save = async (scope: string, customer: string | null, version: string | null, current: string | null = null,
    key = crypto.randomUUID()) => (await db.query<{ id: string }>(
    'select public.save_recipe_assignment($1,$2,$3,$4,$5,$6,$7) id',
    [refs!.item_id,customer,scope,version,current,'Referência fictícia de associação',key],
  )).rows[0]!.id
  await asUser(sales)
  const demand = async (customer_id: string) => {
    const input = {customer_id,delivery_date:'2099-02-03',items:[{item_id:refs!.item_id,unit:'kg',quantity:'20',unit_price:'10'}]}
    const order = (await db.query<{ id: string }>('select public.create_order_draft($1,$2) id',
      [JSON.stringify(input),crypto.randomUUID()])).rows[0]!.id
    await db.query('select public.confirm_order($1,1,$2)',[order,crypto.randomUUID()])
    return (await db.query<{ id: string }>('select id from public.order_items where order_id=$1',[order])).rows[0]!.id
  }
  const first = await demand(refs!.customer_a!)
  const second = await demand(refs!.customer_b!)
  const current = async (id: string) => (await db.query<{ rule: Record<string, unknown> | null }>(
    'select public.resolve_demand_recipe($1) rule',[id],
  )).rows[0]!.rule
  await expect(current(first)).rejects.toThrow('perfil')
  await asUser(production)
  expect(await current(first)).toBeNull()
  await expect(save('PADRAO',null,refs!.approved_one!)).rejects.toThrow('Somente Administração')
  await asUser(admin)
  await expect(save('PADRAO',null,refs!.pending!)).rejects.toThrow('receita aprovada')
  await expect(save('CLIENTE',null,refs!.approved_one!)).rejects.toThrow('tipo da associação')
  const key = crypto.randomUUID()
  const fallback = await save('PADRAO',null,refs!.approved_one!,null,key)
  expect(await save('PADRAO',null,refs!.approved_one!,null,key)).toBe(fallback)
  const specific = await save('CLIENTE',refs!.customer_a!,refs!.approved_two!)
  await expect(save('CLIENTE',refs!.customer_a!,refs!.approved_one!)).rejects.toThrow('associação mudou')
  await asUser(production)
  expect(await current(first)).toMatchObject({assignment_id:specific,recipe_number:2,scope:'CLIENTE'})
  expect(await current(second)).toMatchObject({assignment_id:fallback,recipe_number:1,scope:'PADRAO'})
  expect((await db.query('select id from public.customer_product_recipes')).rows).toHaveLength(0)
  await asUser(admin)
  await save('CLIENTE',refs!.customer_a!,null,specific)
  expect(await current(first)).toMatchObject({assignment_id:fallback,scope:'PADRAO'})
  expect((await db.query('select id from public.customer_product_recipes where id=$1 and ends_at is not null',[specific])).rows)
    .toHaveLength(1)
})
