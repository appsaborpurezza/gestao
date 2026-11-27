-- Busca sem acento e sem diferenciar maiúsculas em clientes e pedidos.
-- Incremental: adiciona extensões, uma função de normalização e colunas geradas.
-- Não altera RLS, dados existentes nem migrações anteriores.

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- Wrapper imutável (unaccent é STABLE); o dicionário é fixado para que o resultado seja determinístico.
create or replace function public.search_normalize(value text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$ select lower(extensions.unaccent('extensions.unaccent'::regdictionary, value)) $$;

revoke all on function public.search_normalize(text) from public, anon;
grant execute on function public.search_normalize(text) to authenticated, service_role;

alter table public.customers
  add column if not exists search_text text generated always as (public.search_normalize(
    coalesce(legal_name, '') || ' ' || coalesce(trade_name, '') || ' ' || coalesce(city, '') || ' ' || coalesce(contact_name, '')
  )) stored;

alter table public.orders
  add column if not exists search_text text generated always as (public.search_normalize(coalesce(customer_name, ''))) stored;

create index if not exists customers_search_text_trgm on public.customers using gin (search_text extensions.gin_trgm_ops);
create index if not exists orders_search_text_trgm on public.orders using gin (search_text extensions.gin_trgm_ops);

comment on column public.customers.search_text is 'Razão social, nome fantasia, cidade e contato normalizados (sem acento, minúsculas) para busca.';
comment on column public.orders.search_text is 'Nome do cliente normalizado (sem acento, minúsculas) para busca.';
