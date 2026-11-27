import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { unaccent } from '@electric-sql/pglite/contrib/unaccent'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { afterAll, beforeAll, expect, test } from 'vitest'

// Ciclo de vida dos cadastros (migration 20261127001000) sobre o schema completo.
const db = new PGlite({ extensions: { unaccent, pg_trgm } })
const admin = '00000000-0000-4000-8000-000000000001'
const sales = '00000000-0000-4000-8000-000000000002'
const production = '00000000-0000-4000-8000-000000000003'
const key = () => globalThis.crypto.randomUUID()

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean not null default false);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    grant usage on schema extensions to authenticated;
  `)
  const dir = new URL('../supabase/migrations/', import.meta.url)
  for (const name of (await readdir(dir)).filter(file => file.endsWith('.sql')).sort()) {
    // A publicação Realtime não existe no PGlite.
    const sql = (await readFile(new URL(name, dir), 'utf8')).replace(/alter publication[^;]*;/gi, '')
    await db.exec(sql)
  }
  for (const [id, role] of [[admin, 'ADMINISTRADOR'], [sales, 'VENDAS'], [production, 'PRODUCAO']]) {
    await db.query('insert into auth.users(id) values ($1)', [id])
    await db.query('insert into public.profiles(id, display_name, role, active, can_approve_recipe, can_release_lot) values ($1,$2,$3,true,$4,$4)',
      [id, role, role, role === 'ADMINISTRADOR'])
  }
}, 60_000)
afterAll(async () => db.close())

async function as(id: string) {
  await db.exec('set role authenticated')
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id])
}
const preview = async (entity: string, id: string) =>
  (await db.query<{ p: Record<string, any> }>('select public.catalog_dependencies($1,$2) p', [entity, id])).rows[0]!.p
const remove = (entity: string, id: string, version: number, k = key()) =>
  db.query<{ id: string }>('select public.delete_catalog_record($1,$2,$3,$4,$5) id', [entity, id, version, 'Teste', k])
const setActive = (entity: string, id: string, version: number, active: boolean, k = key()) =>
  db.query<{ v: number }>('select public.set_catalog_active($1,$2,$3,$4,$5,$6) v', [entity, id, version, active, active ? null : 'Teste', k])
const saveItem = (target: string | null, version: number | null, input: Record<string, unknown>, k = key()) =>
  db.query<{ id: string }>('select public.save_item($1,$2,$3,$4) id', [target, version, JSON.stringify(input), k])
const supplier = async (name: string) => {
  await as(admin)
  return (await db.query<{ id: string }>('select public.save_operational_catalog($1,null,null,$2,$3) id',
    ['FORNECEDOR', JSON.stringify({ label: name, active: true }), key()])).rows[0]!.id
}

test('exclui fornecedor sem dependências, audita e é idempotente', async () => {
  const id = await supplier('Fornecedor sem uso')
  const p = await preview('FORNECEDOR', id)
  expect(p).toMatchObject({ can_delete: true, can_deactivate: true, record_version: 1, dependencies: [] })
  const k = key()
  expect((await remove('FORNECEDOR', id, 1, k)).rows[0]!.id).toBe(id)
  expect((await remove('FORNECEDOR', id, 1, k)).rows[0]!.id).toBe(id)
  expect((await db.query('select 1 from public.suppliers where id = $1', [id])).rows).toHaveLength(0)
  const history = (await db.query<{ h: any }>('select public.catalog_history($1,$2) h', ['FORNECEDOR', id])).rows[0]!.h
  expect(history.rows.map((row: any) => row.action)).toEqual(['EXCLUIR_CADASTRO', 'SALVAR_CADASTRO_OPERACIONAL'])
})

test('bloqueia exclusão com histórico, oferece inativação e reativação versionadas', async () => {
  const id = await supplier('Fornecedor com recebimento')
  await db.exec('reset role')
  await db.query(`insert into public.receipts(supplier_id, invoice_number, actor) values ($1, 'NF-1', $2)`, [id, admin])
  await as(admin)
  const p = await preview('FORNECEDOR', id)
  expect(p.can_delete).toBe(false)
  expect(p.dependencies).toEqual([{ type: 'receipts', label: 'Recebimentos', count: 1 }])
  await expect(remove('FORNECEDOR', id, 1)).rejects.toThrow('histórico de utilização')
  expect((await setActive('FORNECEDOR', id, 1, false)).rows[0]!.v).toBe(2)
  await expect(setActive('FORNECEDOR', id, 1, true)).rejects.toThrow('alterado por outro usuário')
  expect((await setActive('FORNECEDOR', id, 2, true)).rows[0]!.v).toBe(3)
})

test('dependência criada entre a prévia e a confirmação bloqueia a exclusão', async () => {
  const id = await supplier('Fornecedor disputado')
  expect((await preview('FORNECEDOR', id)).can_delete).toBe(true)
  await db.exec('reset role')
  await db.query(`insert into public.receipts(supplier_id, invoice_number, actor) values ($1, 'NF-2', $2)`, [id, admin])
  await as(admin)
  await expect(remove('FORNECEDOR', id, 1)).rejects.toThrow('histórico')
  expect((await db.query('select 1 from public.suppliers where id = $1', [id])).rows).toHaveLength(1)
})

test('local com saldo não pode ser inativado nem excluído', async () => {
  await db.exec('reset role')
  const { rows: [refs] } = await db.query<{ item: string; loc: string; lot: string }>(`
    with i as (insert into public.items(original_code, original_description, classification, base_unit) values ('LC-1','Insumo local','INSUMO','kg') returning id),
      l as (insert into public.locations(code) values ('LOC-SALDO') returning id),
      m as (insert into public.manufacturers(name) values ('Fabricante local') returning id),
      s as (insert into public.suppliers(name) values ('Fornecedor local') returning id),
      rc as (insert into public.receipts(supplier_id, invoice_number, actor) select s.id, 'NF-L', '${admin}' from s returning id),
      lot as (insert into public.inventory_lots(receipt_id, item_id, manufacturer_id, original_lot, unit, expiry, expires_on)
        select rc.id, i.id, m.id, 'L1', 'kg', 'INFORMADA', '2099-01-01' from rc, i, m returning id)
    select (select id from i) item, (select id from l) loc, (select id from lot) lot`)
  await db.query('insert into public.stock_balances(lot_id, location_id, quantity) values ($1,$2,5)', [refs!.lot, refs!.loc])
  await as(admin)
  const p = await preview('LOCAL', refs!.loc)
  expect(p).toMatchObject({ can_delete: false, can_deactivate: false })
  expect(p.deactivation_blockers).toContain('Local possui saldo físico.')
  await expect(setActive('LOCAL', refs!.loc, 1, false)).rejects.toThrow('saldo físico')
  const item = await preview('INSUMO', refs!.item)
  expect(item.can_deactivate).toBe(false)
  await expect(preview('PRODUTO', refs!.item)).rejects.toThrow('não encontrado')
})

test('produto: cria, impede código duplicado, edita com versão e exclui enquanto não tem uso', async () => {
  await as(admin)
  const input = { code: 'NOVO-1', description: 'Pão de queijo 1 kg (teste)', commercial_description: 'Pão de queijo', classification: 'FABRICACAO_PROPRIA', unit: 'un' }
  const k = key()
  const id = (await saveItem(null, null, input, k)).rows[0]!.id
  expect((await saveItem(null, null, input, k)).rows[0]!.id).toBe(id)
  await expect(saveItem(null, null, { ...input, code: 'novo-1' })).rejects.toThrow('com este código')
  const similar = await db.query('select code from public.catalog_similar($1,$2)', ['PRODUTO', 'pao de QUEIJO'])
  expect(similar.rows).toEqual([{ code: 'NOVO-1' }])
  await saveItem(id, 1, { ...input, commercial_description: 'Pão de queijo tradicional' })
  await expect(saveItem(id, 1, input)).rejects.toThrow('alterado por outro usuário')
  expect((await preview('PRODUTO', id))).toMatchObject({ can_delete: true, record_version: 2 })
  await remove('PRODUTO', id, 2)
  expect((await db.query('select 1 from public.items where id = $1', [id])).rows).toHaveLength(0)
})

test('versão de receita aprovada ou única nunca é excluída', async () => {
  await db.exec('reset role')
  const { rows: [r] } = await db.query<{ v1: string; v2: string }>(`
    with r as (insert into public.recipes(code, name) values ('RC-T','Receita teste') returning id),
      v1 as (insert into public.recipe_versions(recipe_id, version, status, yield_min, yield_target, yield_max) select id,1,'APROVADA',1,2,3 from r returning id),
      v2 as (insert into public.recipe_versions(recipe_id, version, status, yield_min, yield_target, yield_max) select id,2,'PENDENTE_VALIDACAO',1,2,3 from r returning id)
    select (select id from v1) v1, (select id from v2) v2`)
  await db.query(`insert into public.recipe_ingredients(recipe_version_id, source_name, ordinal, unit) values ($1,'Água',1,'L')`, [r!.v2])
  await as(admin)
  const approved = await preview('VERSAO_RECEITA', r!.v1)
  expect(approved.can_delete).toBe(false)
  expect(approved.reasons).toContain('Versões aprovadas são preservadas.')
  const draft = await preview('VERSAO_RECEITA', r!.v2)
  expect(draft.can_delete).toBe(true)
  await remove('VERSAO_RECEITA', r!.v2, 0)
  expect((await db.query('select count(*)::int n from public.recipe_ingredients where recipe_version_id = $1', [r!.v2])).rows).toEqual([{ n: 0 }])
  expect((await preview('VERSAO_RECEITA', r!.v1)).reasons).toContain('É a única versão da receita.')
})

test('perfis sem Administração não consultam nem alteram cadastros por RPC', async () => {
  const id = await supplier('Fornecedor protegido')
  for (const user of [sales, production]) {
    await as(user)
    await expect(preview('FORNECEDOR', id)).rejects.toThrow('Administração')
    await expect(remove('FORNECEDOR', id, 1)).rejects.toThrow('Administração')
    await expect(setActive('FORNECEDOR', id, 1, false)).rejects.toThrow('Administração')
  }
  await as(admin)
  await expect(preview('PEDIDO', id)).rejects.toThrow('não suportado')
  await expect(db.query("select public.delete_catalog_record('public.orders; drop table x',$1,1,null,$2)", [id, key()])).rejects.toThrow('não suportado')
})
