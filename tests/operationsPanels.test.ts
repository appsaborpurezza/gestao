import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { unaccent } from '@electric-sql/pglite/contrib/unaccent'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { afterAll, beforeAll, expect, test } from 'vitest'

// Painéis departamentais (migration 20261127001300) sobre o schema completo.
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


const day = (offset: number) => `((now() at time zone 'America/Sao_Paulo')::date + ${offset})`
const ts = (hoursAgo: number) => `(now() - interval '${hoursAgo} hours')`
const id = (n: number) => `'00000000-0000-4000-8000-${String(n).padStart(12, '0')}'`

// Dados mínimos sem gatilhos nem FKs (replica): só a leitura dos painéis é exercitada.
beforeAll(async () => {
  await db.exec(`do $$ declare c record; begin
    for c in select conrelid::regclass t, conname from pg_constraint where contype = 'c'
      and conrelid in ('public.production_batches'::regclass, 'public.batch_finished_outputs'::regclass,
        'public.production_batch_stages'::regclass, 'public.orders'::regclass, 'public.inventory_lots'::regclass) loop
      execute format('alter table %s drop constraint %I', c.t, c.conname);
    end loop; end $$;`)
  await db.exec(`set session_replication_role = replica;
    insert into public.production_demands(order_item_id, order_id, order_number, delivery_date, customer_name, item_id, item_code, description, unit, quantity, requested_kg) values
      (${id(101)}, gen_random_uuid(), 1, ${day(-1)}, 'Cantina A', gen_random_uuid(), 'P1', 'Talharim', 'un', 10, 30),
      (${id(102)}, gen_random_uuid(), 2, ${day(-2)}, 'Pastelaria B', gen_random_uuid(), 'P2', 'Pastel', 'un', 10, 20);
    insert into public.production_orders(id, production_number, demand_id, assignment_id, recipe_version_id, recipe_name, recipe_snapshot, yield_mode, target_kg, yield_kg, batches_count, reason, planned_by)
      overriding system value values
      (${id(201)}, 7001, ${id(101)}, gen_random_uuid(), gen_random_uuid(), 'TALHARIM', '{}', 'MEDIO', 30, 10, 3, 'x', '${admin}'),
      (${id(202)}, 7002, ${id(102)}, gen_random_uuid(), gen_random_uuid(), 'PASTEL', '{}', 'MEDIO', 20, 10, 2, 'x', '${admin}');
    insert into public.production_batches(id, production_order_id, sequence, status, version, lot_code, started_by, started_at) values
      (${id(301)}, ${id(201)}, 1, 'FINALIZADA', 5, 'L1', '${admin}', ${ts(5)}),
      (${id(302)}, ${id(201)}, 2, 'FINALIZADA', 5, 'L2', '${admin}', ${ts(4)}),
      (${id(303)}, ${id(201)}, 3, 'PLANEJADA', 1, null, null, null),
      (${id(304)}, ${id(202)}, 1, 'FINALIZADA', 5, 'L4', '${admin}', ${ts(3)}),
      (${id(305)}, ${id(202)}, 2, 'FINALIZADA', 5, 'L5', '${admin}', ${ts(3)});
    insert into public.batch_finished_outputs(batch_id, packing_config_id, output_lot_id, output_movement_id, unit_count, nominal_kg, actual_kg,
      rejected_packages, rejected_labels, available_kg, finished_at, finished_by) values
      (${id(301)}, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 10, 10, 9, 0, 0, 10, ${ts(1)}, '${admin}'),
      (${id(302)}, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 10, 10, 10, 0, 0, 10, ${ts(1)}, '${admin}'),
      (${id(304)}, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 10, 10, null, 0, 0, 10, ${ts(1)}, '${admin}'),
      (${id(305)}, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 10, 10, null, 0, 0, 10, ${ts(1)}, '${admin}');
    insert into public.production_batch_stages(batch_id, stage, status, started_by, started_at, finished_at, finished_by) values
      (${id(301)}, 'PREPARACAO', 'CONCLUIDA', '${admin}', ${ts(5)}, ${ts(4)}, '${admin}'),
      (${id(302)}, 'PREPARACAO', 'CONCLUIDA', '${admin}', ${ts(4)}, ${ts(2)}, '${production}');
    insert into public.production_stage_pauses(batch_id, stage, reason, paused_at, paused_by, resumed_at, resumed_by) values
      (${id(302)}, 'PREPARACAO', 'pausa', ${ts(3)}, '${admin}', ${ts(2.5)}, '${admin}');
    insert into public.loss_reasons(id, name) values (${id(401)}, 'Massa rasgada');
    insert into public.loss_destinations(id, name, authorization_reference, authorized_by) values (${id(402)}, 'Ração', 'ok', '${admin}');
    insert into public.production_losses(batch_id, operation, quantity_kg, reason_id, destination_id, occurred_at, recorded_by) values
      (${id(301)}, 'PREPARACAO', 1, ${id(401)}, ${id(402)}, ${ts(2)}, '${admin}');
    insert into public.items(id, original_code, original_description, classification) values
      (${id(501)}, 'FAR', 'Farinha', 'INSUMO'), (${id(502)}, 'TAL', 'Talharim', 'FABRICACAO_PROPRIA');
    insert into public.inventory_lots(id, receipt_id, item_id, manufacturer_id, original_lot, expires_on, expiry, unit, status, production_batch_id) values
      (${id(601)}, gen_random_uuid(), ${id(501)}, gen_random_uuid(), 'F1', ${day(3)}, 'INFORMADA', 'kg', 'LIBERADO', null),
      (${id(602)}, gen_random_uuid(), ${id(501)}, gen_random_uuid(), 'F2', ${day(-1)}, 'INFORMADA', 'g', 'BLOQUEADO', null),
      (${id(603)}, gen_random_uuid(), ${id(502)}, gen_random_uuid(), 'T1', ${day(20)}, 'INFORMADA', 'kg', 'LIBERADO', ${id(301)}),
      (${id(604)}, gen_random_uuid(), ${id(502)}, gen_random_uuid(), 'T2', ${day(20)}, 'INFORMADA', 'kg', 'QUARENTENA', ${id(302)});
    insert into public.stock_balances(lot_id, location_id, quantity) values
      (${id(601)}, gen_random_uuid(), 50), (${id(602)}, gen_random_uuid(), 2000), (${id(603)}, gen_random_uuid(), 9), (${id(604)}, gen_random_uuid(), 10);
    insert into public.recall_cases(root_lot_id, reason, opened_by, opened_at) values (${id(602)}, 'teste', '${admin}', ${ts(1)});
    insert into public.orders(id, customer_id, customer_name, seller_id, delivery_date, fulfillment_status) values
      (${id(701)}, gen_random_uuid(), 'Cantina A', '${sales}', ${day(-1)}, 'EXPEDIDO'),
      (${id(702)}, gen_random_uuid(), 'Pastelaria B', '${sales}', ${day(-2)}, 'CONFIRMADO'),
      (${id(703)}, gen_random_uuid(), 'Pastelaria B', '${sales}', ${day(-2)}, 'RASCUNHO');
    insert into public.order_items(order_id, item_id, line_number, item_code, description, unit, quantity, kg_per_unit) values
      (${id(701)}, ${id(502)}, 1, 'TAL', 'Talharim', 'un', 10, 3),
      (${id(702)}, ${id(502)}, 1, 'TAL', 'Talharim', 'kg', 20, null);
    insert into public.billing_records(order_id, invoice_number, issued_on, amount, registered_by) values
      (${id(701)}, '123', ${day(0)}, 450.50, '${sales}');
    set session_replication_role = origin;`)
})

const panels = async (filters: Record<string, unknown> = {}, from = -7, to = 0) =>
  (await db.query<{ p: any }>(`select public.operations_panels(${day(from)}, ${day(to)}, $1) p`, [JSON.stringify(filters)])).rows[0]!.p

test('produção: planejado x realizado, rendimento, tempos por etapa', async () => {
  await as(production)
  const p = (await panels()).production
  expect(p.plan).toMatchObject({ orders: 2, batches_planned: 5, batches_done: 4, complete: 1, on_time: 0, late: 1 })
  expect(Number(p.plan.planned_kg)).toBe(50)
  expect(Number(p.plan.produced_kg)).toBe(39)
  expect(Number(p.plan.attainment_pct)).toBe(78)
  expect(p.finished_batches).toBe(4)
  expect(Number(p.yield_pct)).toBe(95)
  const talharim = p.by_recipe.find((r: any) => r.recipe_name === 'TALHARIM')
  expect(talharim).toMatchObject({ batches: 2, measured: 2 })
  expect(Number(talharim.loss_kg)).toBe(1)
  const prep = p.by_stage[0]
  expect(prep).toMatchObject({ stage: 'PREPARACAO', completed: 2, operators: 2 })
  expect(Number(prep.avg_minutes)).toBe(75) // 60 min e 90 min líquidos (2 h menos 30 min de pausa)
  expect(Number(prep.avg_pause_minutes)).toBe(15)
  expect(Number(prep.kg_per_hour)).toBe(8)
})

test('estoque, qualidade e filtros reais', async () => {
  await as(admin)
  const all = await panels()
  expect(all.stock).toMatchObject({ lots: 4, quarantine: 1, blocked: 1, expired: 1, expiring_7: 1, expiring_30: 3 })
  expect(Number(all.stock.kg)).toBe(71)
  expect(Number(all.stock.finished_goods_kg)).toBe(9)
  expect(all.quality).toMatchObject({ underweight: 1, measured: 2, recalls_opened: 1, recalls_open: 1, pending_release: 1 })
  expect(Number(all.quality.loss_kg)).toBe(1)
  expect(all.quality.by_reason[0]).toMatchObject({ name: 'Massa rasgada' })
  const pastel = await panels({ recipe: 'PASTEL' })
  expect(pastel.production.plan.orders).toBe(1)
  expect(Number(pastel.quality.loss_kg)).toBe(0)
  const insumo = await panels({ classification: 'INSUMO' })
  expect(insumo.stock.lots).toBe(2)
  expect(Number(insumo.stock.kg)).toBe(52)
})

test('comercial só para quem vende; Produção não vê valores', async () => {
  await as(sales)
  const s = await panels()
  expect(s.production).toBeNull()
  expect(s.stock).toBeNull()
  expect(s.commercial).toMatchObject({ orders: 2, shipped: 1, open: 1, overdue: 1 })
  expect(Number(s.commercial.ordered_kg)).toBe(50)
  expect(Number(s.commercial.billed_amount)).toBe(450.5)
  expect(s.commercial.customers[0]).toMatchObject({ customer_name: 'Cantina A', orders: 1 })
  expect((await panels({ customer: 'Pastelaria B' })).commercial.orders).toBe(1)
  await as(production)
  expect((await panels()).commercial).toBeNull()
})

test('período e filtros inválidos são recusados', async () => {
  await as(admin)
  await expect(panels({ recipe: 1 })).rejects.toThrow('Confira os filtros')
  await expect(panels({ table: 'x' })).rejects.toThrow('Confira os filtros')
  await expect(panels({ classification: 'X' })).rejects.toThrow('Confira os filtros')
  await expect(panels({}, 0, 1)).rejects.toThrow('Confira o período')
  await expect(panels({}, -400, 0)).rejects.toThrow('Confira o período')
  await as('00000000-0000-4000-8000-0000000000ff')
  await expect(panels()).rejects.toThrow('não pode consultar')
})
