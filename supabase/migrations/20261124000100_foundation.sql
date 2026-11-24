create schema purezza_private;
revoke all on schema purezza_private from public, anon, authenticated;
grant usage on schema purezza_private to authenticated;

create type public.app_role as enum ('ADMINISTRADOR', 'VENDAS', 'PRODUCAO');
create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null check (btrim(display_name) <> ''),
  role public.app_role not null,
  active boolean not null default true,
  can_approve_recipe boolean not null default false,
  can_release_lot boolean not null default false,
  created_at timestamptz not null default now()
);

create function purezza_private.has_role(variadic allowed public.app_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select from public.profiles
    where id = (select auth.uid()) and active and role = any(allowed)
  )
$$;
revoke all on function purezza_private.has_role(public.app_role[]) from public, anon, authenticated;
grant execute on function purezza_private.has_role(public.app_role[]) to authenticated;

create table public.items (
  id uuid primary key default gen_random_uuid(),
  original_code text not null unique check (btrim(original_code) <> ''),
  original_description text not null check (btrim(original_description) <> ''),
  commercial_description text,
  classification text not null check (classification in (
    'TERCEIRO', 'FABRICACAO_PROPRIA', 'REVENDA_A_VALIDAR', 'FARINHA_USO_REVENDA_A_VALIDAR', 'INSUMO'
  )),
  validation_status text not null default 'PENDENTE_VALIDACAO'
    check (validation_status in ('PENDENTE_VALIDACAO', 'VALIDADO')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (btrim(code) <> ''),
  name text not null check (btrim(name) <> '')
);

create table public.recipe_versions (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete restrict,
  version integer not null check (version > 0),
  status text not null default 'PENDENTE_VALIDACAO' check (status = 'PENDENTE_VALIDACAO'),
  yield_min numeric(18,6) not null check (yield_min > 0),
  yield_target numeric(18,6) not null check (yield_target >= yield_min),
  yield_max numeric(18,6) not null check (yield_max >= yield_target),
  created_at timestamptz not null default now(),
  unique (recipe_id, version)
);

create table public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_version_id uuid not null references public.recipe_versions(id) on delete restrict,
  source_name text not null check (btrim(source_name) <> ''),
  item_id uuid references public.items(id) on delete restrict,
  ordinal integer not null check (ordinal > 0),
  quantity numeric(18,6) check (quantity > 0),
  unit text not null check (unit in ('kg', 'g', 'L', 'mL', 'un')),
  stage text check (stage in ('PREPARACAO', 'BATER_MASSA')),
  tolerance numeric(18,6) check (tolerance >= 0),
  unique (recipe_version_id, ordinal)
);

create index recipe_ingredients_item_idx on public.recipe_ingredients(item_id);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor uuid not null references public.profiles(id) on delete restrict,
  action text not null,
  details jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.items enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_versions enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.audit_logs enable row level security;

revoke all on public.profiles, public.items, public.recipes, public.recipe_versions,
  public.recipe_ingredients, public.audit_logs from public, anon, authenticated;
grant select on public.profiles, public.items, public.recipes, public.recipe_versions,
  public.recipe_ingredients, public.audit_logs to authenticated;

create policy profiles_self_or_admin on public.profiles for select to authenticated using (
  (id = (select auth.uid()) and active)
  or (select purezza_private.has_role('ADMINISTRADOR'))
);
create policy items_active_team on public.items for select to authenticated using (
  (select purezza_private.has_role('ADMINISTRADOR', 'PRODUCAO'))
  or (active and classification <> 'INSUMO' and (select purezza_private.has_role('VENDAS')))
);
create policy recipes_technical_team on public.recipes for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR', 'PRODUCAO')));
create policy recipe_versions_technical_team on public.recipe_versions for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR', 'PRODUCAO')));
create policy recipe_ingredients_technical_team on public.recipe_ingredients for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR', 'PRODUCAO')));
create policy audit_admin on public.audit_logs for select to authenticated
  using ((select purezza_private.has_role('ADMINISTRADOR')));
