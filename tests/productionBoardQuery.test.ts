import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { unaccent } from '@electric-sql/pglite/contrib/unaccent'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { afterAll, beforeAll, expect, test } from 'vitest'

// Consulta do Kanban v2 (migration 20261127001200) sobre o schema completo.
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

// Dados mínimos inseridos sem gatilhos nem FKs (replica): só a leitura do quadro é exercitada.
beforeAll(async () => {
  // Banco de teste local: as CHECKs de etapa exigem o fluxo completo de produção, que aqui não interessa.
  await db.exec(`do $$ declare c record; begin
    for c in select conrelid::regclass t, conname from pg_constraint where contype = 'c'
      and conrelid in ('public.production_batches'::regclass, 'public.batch_finished_outputs'::regclass, 'public.production_batch_stages'::regclass) loop
      execute format('alter table %s drop constraint %I', c.t, c.conname);
    end loop; end $$;`)
  await db.exec(`set session_replication_role = replica;
    insert into public.production_demands(order_item_id, order_id, order_number, delivery_date, customer_name, item_id, item_code, description, unit, quantity, requested_kg)
      values ('00000000-0000-4000-8000-00000000d001', gen_random_uuid(), 501, (now() at time zone 'America/Sao_Paulo')::date - 1, 'Cliente Atrasado', gen_random_uuid(), 'P1', 'Talharim', 'un', 10, 30),
             ('00000000-0000-4000-8000-00000000d002', gen_random_uuid(), 502, (now() at time zone 'America/Sao_Paulo')::date + 10, 'Cliente Folgado', gen_random_uuid(), 'P2', 'Lasanha', 'un', 10, 20);
    insert into public.production_orders(id, production_number, demand_id, assignment_id, recipe_version_id, recipe_name, recipe_snapshot, yield_mode, target_kg, yield_kg, batches_count, reason, planned_by)
      overriding system value values ('00000000-0000-4000-8000-00000000a001', 9001, '00000000-0000-4000-8000-00000000d001', gen_random_uuid(), gen_random_uuid(), 'R', '{}', 'MEDIO', 30, 10, 3, 'x', '${admin}'),
             ('00000000-0000-4000-8000-00000000a002', 9002, '00000000-0000-4000-8000-00000000d002', gen_random_uuid(), gen_random_uuid(), 'R', '{}', 'MEDIO', 20, 10, 2, 'x', '${admin}');
    insert into public.production_batches(id, production_order_id, sequence, status, version, lot_code, started_by, started_at) values
      ('00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-00000000a001', 1, 'EM_PREPARACAO', 2, 'L-1', '${admin}', now() - interval '1 hour'),
      ('00000000-0000-4000-8000-0000000b0002', '00000000-0000-4000-8000-00000000a001', 2, 'PLANEJADA', 1, null, null, null),
      ('00000000-0000-4000-8000-0000000b0003', '00000000-0000-4000-8000-00000000a001', 3, 'FINALIZADA', 5, 'L-3', '${admin}', now() - interval '1 hour'),
      ('00000000-0000-4000-8000-0000000b0004', '00000000-0000-4000-8000-00000000a002', 1, 'EM_PREPARACAO', 2, 'L-4', '${admin}', now() - interval '1 hour'),
      ('00000000-0000-4000-8000-0000000b0005', '00000000-0000-4000-8000-00000000a002', 2, 'PLANEJADA', 1, null, null, null);
    insert into public.production_batch_stages(batch_id, stage, status, started_by, started_at) values
      ('00000000-0000-4000-8000-0000000b0001', 'PREPARACAO', 'EM_EXECUCAO', '${admin}', now() - interval '30 minutes'),
      ('00000000-0000-4000-8000-0000000b0004', 'PREPARACAO', 'PAUSADA', '${admin}', now() - interval '5 minutes');
    insert into public.batch_finished_outputs(batch_id, packing_config_id, output_lot_id, output_movement_id, unit_count, nominal_kg, actual_kg,
      rejected_packages, rejected_labels, available_kg, finished_at, finished_by) values
      ('00000000-0000-4000-8000-0000000b0003', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 10, 10, 9.5, 0, 0, 9.5, now(), '${admin}');
    set session_replication_role = origin;`)
})

const board = async (filters: Record<string, unknown> = {}, sort = 'delivery', offsets = {}) =>
  (await db.query<{ b: any }>('select public.production_board_query(8,$1,$2,$3) b', [JSON.stringify(offsets), JSON.stringify(filters), sort])).rows[0]!.b

test('resume no servidor: estados, atraso, kg e finalizadas de hoje', async () => {
  await as(production)
  const b = await board()
  expect(b.summary).toMatchObject({ active: 4, running: 1, paused: 1, waiting: 2, blocked: 0, late: 2, finished_today: 1, finished_total: 1 })
  expect(Number(b.summary.active_kg)).toBe(40)
  expect(Number(b.summary.finished_today_kg)).toBe(9.5)
  expect(b.columns.EM_PREPARACAO.total).toBe(2)
  expect(Number(b.columns.EM_PREPARACAO.kg)).toBe(20)
  expect(b.columns.EM_PREPARACAO.rows[0]).toMatchObject({ production_number: 9001, operator: 'ADMINISTRADOR' })
})

test('agrupamento por OP com progresso e etapas', async () => {
  await as(production)
  const groups = (await board()).groups
  expect(groups.map((g: any) => g.production_number)).toEqual([9001, 9002])
  expect(groups[0]).toMatchObject({ batches_count: 3, done: 1, late: true, by_stage: { EM_PREPARACAO: 1, PLANEJADA: 1, FINALIZADA: 1 } })
})

test('filtros combináveis e ordenação', async () => {
  await as(production)
  expect((await board({ states: ['paused'] })).summary.active).toBe(1)
  expect((await board({ deadline: 'late' })).groups.map((g: any) => g.production_number)).toEqual([9001])
  expect((await board({ deadline: 'late', states: ['waiting'] })).summary.waiting).toBe(1)
  expect((await board({ production_number: 9002 })).summary.active).toBe(2)
  expect((await board({ search: 'lasanha' })).summary.active).toBe(2)
  expect((await board({}, 'stage_time')).columns.EM_PREPARACAO.rows.map((r: any) => r.production_number)).toEqual([9001, 9002])
  expect((await board({}, 'op')).columns.PLANEJADA.rows.map((r: any) => r.production_number)).toEqual([9001, 9002])
})

test('Vendas não vê operador; filtros inválidos são recusados', async () => {
  await as(sales)
  expect((await board()).columns.EM_PREPARACAO.rows[0].operator).toBeNull()
  await expect(board({ states: ['x'] })).rejects.toThrow('Confira os filtros')
  await expect(board({ deadline: 'ontem' })).rejects.toThrow('Confira os filtros')
  await expect(board({ delivery_from: 'abc' })).rejects.toThrow('Confira os filtros')
  await expect(board({}, 'drop')).rejects.toThrow('Confira os filtros')
  await as('00000000-0000-4000-8000-0000000000ff')
  await expect(board()).rejects.toThrow('não pode consultar')
})
