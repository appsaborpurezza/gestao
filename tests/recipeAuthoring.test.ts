import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { unaccent } from '@electric-sql/pglite/contrib/unaccent'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { afterAll, beforeAll, expect, test } from 'vitest'

// Autoria de receitas (migration 20261127001100) sobre o schema completo.
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

const flour = async () => {
  await db.exec('reset role')
  return (await db.query<{ id: string }>(`insert into public.items(original_code, original_description, classification, base_unit, active)
    values ('INS-' || substr(md5(random()::text),1,6), 'Farinha de trigo', 'INSUMO', 'kg', true) returning id`)).rows[0]!.id
}
const create = (input: Record<string, unknown>, k = key()) =>
  db.query<{ id: string }>('select public.create_recipe($1,$2) id', [JSON.stringify(input), k])
const base = (code: string, item?: string) => ({ code, name: 'Massa ' + code, yield_min: '9,5', yield_target: '10', yield_max: '10.5',
  ingredients: [{ item_id: item ?? '', quantity: '5', unit: '' }, { source_name: 'Água', quantity: '3', unit: 'L' }] })
const versions = async (code: string) => (await db.query<{ version: number; status: string; n: number }>(`select v.version, v.status,
  (select count(*)::int from public.recipe_ingredients i where i.recipe_version_id = v.id) n
  from public.recipe_versions v join public.recipes r on r.id = v.recipe_id where r.code = $1 order by v.version`, [code])).rows

test('cria receita pendente com ingredientes, é idempotente e recusa código duplicado', async () => {
  const item = await flour()
  await as(admin)
  const k = key()
  const id = (await create(base('R-NOVA', item), k)).rows[0]!.id
  expect((await create(base('R-NOVA', item), k)).rows[0]!.id).toBe(id)
  expect(await versions('R-NOVA')).toEqual([{ version: 1, status: 'PENDENTE_VALIDACAO', n: 2 }])
  const line = (await db.query<{ source_name: string; unit: string }>('select source_name, unit from public.recipe_ingredients where recipe_version_id = $1 and ordinal = 1', [id])).rows[0]
  expect(line).toEqual({ source_name: 'Farinha de trigo', unit: 'kg' })
  await expect(create(base('r-nova'))).rejects.toThrow('Já existe uma receita')
  await expect(create({ ...base('R-X'), yield_min: '11' })).rejects.toThrow('ordem crescente')
  await expect(create({ ...base('R-Y'), ingredients: [] })).rejects.toThrow('de 1 a 80')
})

test('somente Administração cria receitas', async () => {
  for (const role of [sales, production]) {
    await as(role)
    await expect(create(base('R-PERFIL'))).rejects.toThrow('Somente Administração')
  }
})

test('nova versão copia a ficha revisada sem a aprovação e não duplica versão em elaboração', async () => {
  const item = await flour()
  await as(admin)
  const v1 = (await create(base('R-VER', item))).rows[0]!.id
  await expect(db.query('select public.create_recipe_version($1,$2)', [v1, key()])).rejects.toThrow('ainda está em elaboração')
  const lines = (await db.query<{ id: string; ordinal: number }>('select id, ordinal from public.recipe_ingredients where recipe_version_id = $1 order by ordinal', [v1])).rows
  await db.exec('reset role')
  await db.query(`insert into public.recipe_reviews(recipe_version_id, yield_min, yield_target, yield_max, edited_by, review_reference) values ($1, 9, 10, 11, $2, 'Rev 1')`, [v1, admin])
  await db.query(`insert into public.recipe_review_ingredients(recipe_version_id, source_ingredient_id, item_id, quantity, unit, stage, lower_tolerance, upper_tolerance)
    values ($1,$2,$3,4.5,'kg','BATER_MASSA',0.1,0.1), ($1,$4,null,3,'L','BATER_MASSA',0,0)`, [v1, lines[0]!.id, item, lines[1]!.id])
  await db.query(`insert into public.recipe_approvals(recipe_version_id, review_version, approved_by, approval_reference) values ($1,1,$2,'Ata 1')`, [v1, admin])
  await db.query(`update public.recipe_versions set status = 'APROVADA' where id = $1`, [v1])
  await as(admin)
  const k = key()
  const v2 = (await db.query<{ id: string }>('select public.create_recipe_version($1,$2) id', [v1, k])).rows[0]!.id
  expect((await db.query<{ id: string }>('select public.create_recipe_version($1,$2) id', [v1, k])).rows[0]!.id).toBe(v2)
  expect(await versions('R-VER')).toEqual([{ version: 1, status: 'APROVADA', n: 2 }, { version: 2, status: 'PENDENTE_VALIDACAO', n: 2 }])
  const copy = (await db.query<any>(`select (select count(*)::int from public.recipe_approvals where recipe_version_id = $1) approvals,
    (select review_reference from public.recipe_reviews where recipe_version_id = $1) ref,
    (select array_agg(quantity::text order by quantity) from public.recipe_review_ingredients where recipe_version_id = $1) qty,
    (select array_agg(quantity::text order by ordinal) from public.recipe_ingredients where recipe_version_id = $1) src,
    (select yield_max::text from public.recipe_versions where id = $1) ymax`, [v2])).rows[0]
  expect(copy).toEqual({ approvals: 0, ref: null, qty: ['3.000000', '4.500000'], src: ['4.500000', '3.000000'], ymax: '11.000000' })
  await expect(db.query('select public.create_recipe_version($1,$2)', [v1, key()])).rejects.toThrow('versão em elaboração')
  // A versão aprovada continua intacta e imutável.
  await expect(db.query(`update public.recipe_reviews set review_reference = 'x' where recipe_version_id = $1`, [v1])).rejects.toThrow()
})

test('duplica receita como nova ficha pendente e exclui somente rascunho sem uso', async () => {
  const item = await flour()
  await as(admin)
  const v1 = (await create(base('R-ORIG', item))).rows[0]!.id
  const dup = (await db.query<{ id: string }>('select public.duplicate_recipe($1,$2,$3) id', [v1, JSON.stringify({ code: 'R-COPIA', name: 'Cópia' }), key()])).rows[0]!.id
  expect(await versions('R-COPIA')).toEqual([{ version: 1, status: 'PENDENTE_VALIDACAO', n: 2 }])
  await expect(db.query('select public.duplicate_recipe($1,$2,$3)', [v1, JSON.stringify({ code: 'R-ORIG', name: 'X' }), key()])).rejects.toThrow('Já existe')
  await as(sales)
  await expect(db.query('select public.delete_draft_recipe($1,$2,$3)', [dup, 'Engano', key()])).rejects.toThrow('Somente Administração')
  await as(admin)
  expect((await db.query<{ id: string }>('select public.delete_draft_recipe($1,$2,$3) id', [dup, 'Engano', key()])).rows[0]!.id).toBe(dup)
  expect(await versions('R-COPIA')).toEqual([])
  const audit = (await db.query<any>(`select details->>'entidade' e, details->'registro'->>'codigo' c from public.audit_logs
    where action = 'EXCLUIR_CADASTRO' and details->>'versao_id' = $1`, [dup])).rows
  expect(audit).toEqual([{ e: 'RECEITA', c: 'R-COPIA' }])
  // Receita aprovada nunca é excluída.
  await db.exec('reset role')
  await db.query(`insert into public.recipe_reviews(recipe_version_id, yield_min, yield_target, yield_max, edited_by) values ($1, 9, 10, 11, $2)`, [v1, admin])
  await db.query(`insert into public.recipe_approvals(recipe_version_id, review_version, approved_by, approval_reference) values ($1,1,$2,'Ata')`, [v1, admin])
  await db.query(`update public.recipe_versions set status = 'APROVADA' where id = $1`, [v1])
  await as(admin)
  await expect(db.query('select public.delete_draft_recipe($1,$2,$3)', [v1, 'x', key()])).rejects.toThrow('histórico de utilização')
})
