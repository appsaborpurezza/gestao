import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { unaccent } from '@electric-sql/pglite/contrib/unaccent'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { afterAll, beforeAll, expect, test } from 'vitest'

// Pendências de CRUD e UX (migration 20261127001400) sobre o schema completo.
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

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const q = (sql: string, params: unknown[] = []) => db.query<any>(sql, params)
const one = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params)).rows[0]!)[0] as any
const superuser = async () => { await db.exec('reset role') }

beforeAll(async () => {
  // Banco de teste local: as CHECKs de pedido e massada exigem o fluxo completo, que aqui não interessa.
  await db.exec(`do $$ declare c record; begin
    for c in select conrelid::regclass t, conname from pg_constraint where contype = 'c'
      and conrelid in ('public.orders'::regclass, 'public.production_batches'::regclass) loop
      execute format('alter table %s drop constraint %I', c.t, c.conname);
    end loop; end $$;`)
  await db.exec(`set session_replication_role = replica;
    insert into public.loss_reasons(id, name) values ('${id(1)}', 'Massa rasgada'), ('${id(2)}', 'Queda');
    insert into public.loss_destinations(id, name, authorization_reference, authorized_by) values ('${id(3)}', 'Ração', 'Ofício 1', '${admin}');
    insert into public.items(id, original_code, original_description, classification) values ('${id(10)}', 'TAL', 'Talharim', 'FABRICACAO_PROPRIA');
    insert into public.recipes(id, code, name) values ('${id(20)}', 'R-TAL', 'Talharim');
    insert into public.recipe_versions(id, recipe_id, version, status, yield_min, yield_target, yield_max) values ('${id(21)}', '${id(20)}', 1, 'APROVADA', 9, 10, 11);
    insert into public.recipe_approvals(recipe_version_id, review_version, approved_by, approval_reference) values ('${id(21)}', 1, '${admin}', 'ok');
    insert into public.customer_product_recipes(id, product_id, recipe_version_id, scope, reason, started_by)
      values ('${id(22)}', '${id(10)}', '${id(21)}', 'PADRAO', 'padrão', '${admin}');
    insert into public.item_unit_conversions(id, item_id, version, source_unit, kg_per_unit, reason, approved_by) values
      ('${id(30)}', '${id(10)}', 1, 'un', 3, 'x', '${admin}'), ('${id(31)}', '${id(10)}', 2, 'un', 3.2, 'x', '${admin}');
    insert into public.orders(id, order_number, customer_id, customer_name, seller_id, delivery_date, fulfillment_status)
      overriding system value values ('${id(40)}', 77, gen_random_uuid(), 'Cantina Bella', '${sales}', current_date, 'CONFIRMADO');
    insert into public.order_items(order_id, item_id, line_number, item_code, description, unit, quantity, kg_per_unit, conversion_id)
      values ('${id(40)}', '${id(10)}', 1, 'TAL', 'Talharim', 'un', 10, 3, '${id(30)}');
    insert into public.production_demands(order_item_id, order_id, order_number, delivery_date, customer_name, item_id, item_code, description, unit, quantity, requested_kg)
      values ('${id(50)}', '${id(40)}', 77, current_date, 'Cantina Bella', '${id(10)}', 'TAL', 'Talharim', 'un', 10, 30);
    insert into public.production_orders(id, production_number, demand_id, assignment_id, recipe_version_id, recipe_name, recipe_snapshot, yield_mode, target_kg, yield_kg, batches_count, reason, planned_by)
      overriding system value values ('${id(51)}', 8123, '${id(50)}', '${id(22)}', '${id(21)}', 'Talharim', '{}', 'MEDIO', 30, 10, 3, 'x', '${admin}');
    insert into public.production_batches(id, production_order_id, sequence, status, version, lot_code)
      values ('${id(52)}', '${id(51)}', 1, 'PLANEJADA', 1, 'SP-20261127-0042');
    insert into public.shipments(id, order_id, reservation_id, stock_movement_id, quantity, method, dispatched_by)
      values ('${id(60)}', '${id(40)}', gen_random_uuid(), gen_random_uuid(), 5, 'ENTREGA', '${admin}');
    set session_replication_role = origin;`)
})

test('editar motivo e destinação com versão, duplicidade e auditoria', async () => {
  await as(admin)
  await q(`select public.update_loss_option('MOTIVO_PERDA', $1, 1, '{"name":"Massa rasgada no cilindro"}', $2)`, [id(1), key()])
  expect(await one(`select name from public.loss_reasons where id = $1`, [id(1)])).toBe('Massa rasgada no cilindro')
  await expect(q(`select public.update_loss_option('MOTIVO_PERDA', $1, 1, '{"name":"Outro"}', $2)`, [id(1), key()])).rejects.toThrow('alterado por outra pessoa')
  await expect(q(`select public.update_loss_option('MOTIVO_PERDA', $1, 1, '{"name":"QUEDA"}', $2)`, [id(1), key()])).rejects.toThrow()
  await expect(q(`select public.update_loss_option('MOTIVO_PERDA', $1, 2, '{"name":"queda"}', $2)`, [id(1), key()])).rejects.toThrow('Já existe')
  await q(`select public.update_loss_option('DESTINACAO_PERDA', $1, 1, '{"name":"Ração animal","authorization_reference":"Ofício 2"}', $2)`, [id(3), key()])
  const audit = await one(`select details from public.audit_logs where action = 'EDITAR_CADASTRO' and details->>'entidade' = 'DESTINACAO_PERDA'`)
  expect(audit).toMatchObject({ antes: { nome: 'Ração', referencia: 'Ofício 1' }, depois: { nome: 'Ração animal', referencia: 'Ofício 2' } })
  await as(production)
  await expect(q(`select public.update_loss_option('MOTIVO_PERDA', $1, 2, '{"name":"X"}', $2)`, [id(2), key()])).rejects.toThrow('Somente Administração')
})

test('descontinuar receita exige encerrar associações e bloqueia novos usos', async () => {
  await as(admin)
  expect(await one(`select public.recipe_usage($1)`, [id(20)])).toMatchObject({ active_assignments: 1, open_orders: 1 })
  await expect(q(`select public.set_recipe_discontinued($1, true, 'Saiu de linha', $2)`, [id(20), key()])).rejects.toThrow('Encerre antes as 1')
  await superuser()
  await db.exec(`update public.customer_product_recipes set ends_at = now(), ended_by = '${admin}', end_reason = 'fim' where id = '${id(22)}'`)
  await as(admin)
  await q(`select public.set_recipe_discontinued($1, true, 'Saiu de linha', $2)`, [id(20), key()])
  await superuser()
  await expect(db.exec(`insert into public.customer_product_recipes(product_id, recipe_version_id, scope, reason, started_by)
    values ('${id(10)}', '${id(21)}', 'PADRAO', 'nova', '${admin}')`)).rejects.toThrow('descontinuada')
  expect(await one(`select count(*)::int from public.production_orders`)).toBe(1) // OP existente preservada
  await as(admin)
  await q(`select public.set_recipe_discontinued($1, false, 'Voltou', $2)`, [id(20), key()])
  expect(await one(`select discontinued_at from public.recipes where id = $1`, [id(20)])).toBeNull()
  expect(await one(`select count(*)::int from public.audit_logs where action in ('DESCONTINUAR_RECEITA','REATIVAR_RECEITA')`)).toBe(2)
})

test('conversão usada em pedido não é excluída; sem uso é excluída com auditoria', async () => {
  await as(admin)
  expect(await one(`select public.unit_conversion_usage($1)`, [id(30)])).toEqual({ orders: 1 })
  await expect(q(`select public.delete_unit_conversion($1, 'erro', $2)`, [id(30), key()])).rejects.toThrow('já foi usada em pedidos')
  await q(`select public.delete_unit_conversion($1, 'digitação errada', $2)`, [id(31), key()])
  expect(await one(`select count(*)::int from public.item_unit_conversions`)).toBe(1)
  expect(await one(`select details->'registro'->>'versao_vigente' from public.audit_logs where details->>'entidade' = 'CONVERSAO_UNIDADE'`)).toBe('1')
  await superuser()
  await db.exec(`insert into public.item_unit_conversions(id, item_id, version, source_unit, kg_per_unit, reason, approved_by)
    values ('${id(32)}', '${id(10)}', 3, 'un', 3.1, 'x', '${admin}'); update public.items set unit_version = 3 where id = '${id(10)}'`)
  await as(admin)
  await expect(q(`select public.delete_unit_conversion($1, 'x', $2)`, [id(32), key()])).rejects.toThrow('conversão vigente')
  await as(production)
  await expect(q(`select public.delete_unit_conversion($1, 'x', $2)`, [id(30), key()])).rejects.toThrow('Somente Administração')
})

test('busca global encontra OP, massada e expedição conforme o perfil', async () => {
  await as(production)
  const found = async (term: string) => (await q(`select module, reference from public.workspace_search($1)`, [term])).rows
  expect(await found('8123')).toContainEqual({ module: 'production-board', reference: 'OP 8123' })
  expect(await found('sp-20261127-0042')).toContainEqual({ module: 'production-board', reference: 'SP-20261127-0042' })
  expect(await found('cantina')).toContainEqual({ module: 'shipping', reference: 'Pedido 77' })
  await as(sales)
  const sales_rows = await found('cantina')
  expect(sales_rows.some((r: any) => r.module === 'production-board')).toBe(false)
  expect(sales_rows).toContainEqual({ module: 'shipping', reference: 'Pedido 77' })
})

test('linha do tempo só para Administração, com filtros e paginação', async () => {
  await as(admin)
  const all = await one(`select public.activity_timeline('{}', null, 2)`)
  expect(all).toHaveLength(2)
  const older = await one(`select public.activity_timeline('{}', $1, 100)`, [all[1].created_at])
  expect(older.every((e: any) => e.created_at <= all[1].created_at)).toBe(true)
  const recipe = await one(`select public.activity_timeline($1, null, 50)`, [JSON.stringify({ record: id(20) })])
  expect(recipe.map((e: any) => e.action).sort()).toEqual(['DESCONTINUAR_RECEITA', 'REATIVAR_RECEITA'])
  expect(recipe[0].actor).toBe('ADMINISTRADOR')
  expect(await one(`select public.activity_actions()`)).toContain('EDITAR_CADASTRO')
  await expect(q(`select public.activity_timeline('{"sql":"x"}', null, 10)`)).rejects.toThrow('Confira os filtros')
  await as(production)
  await expect(q(`select public.activity_timeline('{}', null, 10)`)).rejects.toThrow('Somente Administração')
})
