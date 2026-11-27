import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { unaccent } from '@electric-sql/pglite/contrib/unaccent'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { afterAll, beforeAll, expect, test } from 'vitest'

const db = new PGlite({ extensions: { unaccent, pg_trgm } })

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema extensions;
    create table public.customers (id serial primary key, legal_name text not null, trade_name text, city text, contact_name text);
    create table public.orders (id serial primary key, customer_name text not null);
    insert into public.customers (legal_name, trade_name, city, contact_name) values
      ('Padaria São João Ltda', 'Pão Quente', 'Maringá', 'Antônio'), ('Cantina Bella', null, 'Londrina', null);
    insert into public.orders (customer_name) values ('Padaria São João Ltda'), ('Cantina Bella');
  `)
  await db.exec(await readFile(new URL('../supabase/migrations/20261127000800_accent_insensitive_search.sql', import.meta.url), 'utf8'))
})
afterAll(async () => { await db.close() })

test('normaliza acentos e maiúsculas', async () => {
  const { rows } = await db.query<{ v: string }>(`select public.search_normalize('São JOÃO Maringá') as v`)
  expect(rows[0]?.v).toBe('sao joao maringa')
})

test('colunas geradas permitem buscar sem acento', async () => {
  const customers = await db.query<{ legal_name: string }>(`select legal_name from public.customers where search_text like '%' || public.search_normalize('sao joao') || '%'`)
  expect(customers.rows.map(row => row.legal_name)).toEqual(['Padaria São João Ltda'])
  const byCity = await db.query(`select 1 from public.customers where search_text like '%maringa%'`)
  expect(byCity.rows).toHaveLength(1)
  const orders = await db.query(`select 1 from public.orders where search_text like '%padaria sao%'`)
  expect(orders.rows).toHaveLength(1)
})

test('coluna acompanha atualizações e não aceita escrita direta', async () => {
  await db.exec(`update public.customers set city = 'Ribeirão Preto' where legal_name = 'Cantina Bella'`)
  const { rows } = await db.query(`select 1 from public.customers where search_text like '%ribeirao%'`)
  expect(rows).toHaveLength(1)
  await expect(db.exec(`update public.customers set search_text = 'x'`)).rejects.toThrow()
})
