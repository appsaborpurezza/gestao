-- Criação de receitas pelo portal: nova receita, nova versão a partir de uma existente,
-- duplicação para nova ficha técnica e exclusão de receita em rascunho sem uso.
-- Incremental: não altera migrations anteriores, FKs, RLS, receitas aprovadas nem dados existentes.
-- A nova versão nasce PENDENTE_VALIDACAO. Aprovações nunca são copiadas.

create function purezza_private.recipe_author_check()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'Somente Administração pode criar receitas e versões.';
  end if;
end
$$;

-- Lê e valida a lista de ingredientes de origem enviada pelo formulário.
create function purezza_private.recipe_source_lines(lines jsonb)
returns table(ordinal int, source_name text, item_id uuid, quantity numeric, unit text)
language plpgsql stable security definer set search_path = '' as $$
declare
  entry jsonb;
  n int := 0;
  qty numeric;
  material uuid;
  material_unit text;
  name text;
  unit_name text;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 or jsonb_array_length(lines) > 80 then
    raise exception using errcode = '22023', message = 'Informe de 1 a 80 ingredientes.';
  end if;
  for entry in select value from jsonb_array_elements(lines) loop
    n := n + 1;
    material := nullif(entry->>'item_id', '')::uuid;
    name := nullif(btrim(entry->>'source_name'), '');
    unit_name := nullif(btrim(entry->>'unit'), '');
    qty := nullif(replace(entry->>'quantity', ',', '.'), '')::numeric;
    if material is not null then
      select coalesce(i.commercial_description, i.original_description), i.base_unit into name, material_unit
        from public.items i where i.id = material and i.active and i.classification in ('INSUMO','FARINHA_USO_REVENDA_A_VALIDAR');
      if not found then raise exception using errcode = '22023', message = 'Há insumo inativo ou inexistente na lista.'; end if;
      unit_name := coalesce(unit_name, material_unit);
    end if;
    if name is null or length(name) > 180 then
      raise exception using errcode = '22023', message = 'Cada ingrediente precisa de um nome (até 180 caracteres).';
    end if;
    if unit_name is null or unit_name not in ('kg','g','L','mL','un') then
      raise exception using errcode = '22023', message = 'Informe a unidade de cada ingrediente.';
    end if;
    if qty is not null and (qty <= 0 or qty >= 1000000000000 or qty <> round(qty, 6)) then
      raise exception using errcode = '22023', message = 'Confira as quantidades dos ingredientes.';
    end if;
    ordinal := n; source_name := name; item_id := material; quantity := qty; unit := unit_name;
    return next;
  end loop;
end
$$;

create function purezza_private.recipe_yields(input jsonb)
returns numeric[] language plpgsql immutable set search_path = '' as $$
declare y numeric[];
begin
  y := array[nullif(replace(input->>'yield_min', ',', '.'), '')::numeric, nullif(replace(input->>'yield_target', ',', '.'), '')::numeric,
    nullif(replace(input->>'yield_max', ',', '.'), '')::numeric];
  if exists(select from unnest(y) q where q is null or not (q > 0 and q < 1000000000000) or q <> round(q, 6))
    or y[2] < y[1] or y[3] < y[2] then
    raise exception using errcode = '22023', message = 'Informe rendimentos mínimo, médio e máximo em ordem crescente.';
  end if;
  return y;
end
$$;

create function purezza_private.create_recipe(input jsonb, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  recipe uuid;
  new_code text := nullif(btrim(input->>'code'), '');
  new_name text := nullif(btrim(input->>'name'), '');
  y numeric[];
begin
  perform purezza_private.recipe_author_check();
  if jsonb_typeof(input) is distinct from 'object' or new_code is null or length(new_code) > 60 or new_name is null or length(new_name) > 180 then
    raise exception using errcode = '22023', message = 'Informe código (até 60) e nome (até 180 caracteres).';
  end if;
  y := purezza_private.recipe_yields(input);
  result_id := purezza_private.claim_operation('CRIAR_RECEITA', request_id, input);
  if result_id is not null then return result_id; end if;
  perform pg_advisory_xact_lock(hashtextextended('recipe/' || lower(new_code), 0));
  if exists(select from public.recipes where lower(btrim(code)) = lower(new_code)) then
    raise exception using errcode = '23505', message = 'Já existe uma receita com este código.';
  end if;
  insert into public.recipes(code, name) values(new_code, new_name) returning id into recipe;
  insert into public.recipe_versions(recipe_id, version, yield_min, yield_target, yield_max)
    values(recipe, 1, y[1], y[2], y[3]) returning id into result_id;
  insert into public.recipe_ingredients(recipe_version_id, ordinal, source_name, item_id, quantity, unit)
    select result_id, l.ordinal, l.source_name, l.item_id, l.quantity, l.unit from purezza_private.recipe_source_lines(input->'ingredients') l;
  insert into public.audit_logs(actor, action, details) values(auth.uid(), 'CRIAR_RECEITA',
    jsonb_build_object('entidade', 'VERSAO_RECEITA', 'registro_id', result_id, 'receita_id', recipe, 'codigo', new_code, 'versao', 1));
  update public.operation_requests set result = result_id
    where actor = auth.uid() and operation = 'CRIAR_RECEITA' and operation_requests.request_id = create_recipe.request_id;
  return result_id;
end
$$;

-- Copia uma versão (aprovada ou não) para uma nova versão pendente, na mesma receita ou em uma receita nova.
-- Usa os dados revisados quando existem; a ficha revisada também é copiada como rascunho, sem a aprovação.
create function purezza_private.copy_recipe_version(source_version uuid, target_recipe uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  src record;
  review public.recipe_reviews%rowtype;
  next_version int;
  new_id uuid;
begin
  select v.*, r.code into src from public.recipe_versions v join public.recipes r on r.id = v.recipe_id where v.id = source_version;
  if not found then raise exception using errcode = 'P0002', message = 'Versão de receita não encontrada.'; end if;
  select * into review from public.recipe_reviews where recipe_version_id = source_version;
  perform from public.recipes where id = target_recipe for update;
  select coalesce(max(version), 0) + 1 into next_version from public.recipe_versions where recipe_id = target_recipe;
  insert into public.recipe_versions(recipe_id, version, yield_min, yield_target, yield_max)
    values(target_recipe, next_version, coalesce(review.yield_min, src.yield_min), coalesce(review.yield_target, src.yield_target),
      coalesce(review.yield_max, src.yield_max)) returning id into new_id;
  insert into public.recipe_ingredients(recipe_version_id, ordinal, source_name, item_id, quantity, unit, stage)
    select new_id, i.ordinal, i.source_name, coalesce(ri.item_id, i.item_id), coalesce(ri.quantity, i.quantity),
      coalesce(ri.unit, i.unit), coalesce(ri.stage, i.stage)
    from public.recipe_ingredients i
    left join public.recipe_review_ingredients ri on ri.recipe_version_id = i.recipe_version_id and ri.source_ingredient_id = i.id
    where i.recipe_version_id = source_version;
  if review.recipe_version_id is not null then
    insert into public.recipe_reviews(recipe_version_id, yield_min, yield_target, yield_max, shelf_life_days, storage_conditions,
      water_control_reference, review_reference, edited_by)
      values(new_id, review.yield_min, review.yield_target, review.yield_max, review.shelf_life_days, review.storage_conditions,
        review.water_control_reference, null, auth.uid());
    insert into public.recipe_review_ingredients(recipe_version_id, source_ingredient_id, item_id, quantity, unit, stage,
      lower_tolerance, upper_tolerance, technical_reference)
      select new_id, m.id, ri.item_id, ri.quantity, ri.unit, ri.stage, ri.lower_tolerance, ri.upper_tolerance, ri.technical_reference
      from public.recipe_review_ingredients ri
      join public.recipe_ingredients old_line on old_line.id = ri.source_ingredient_id
      join public.recipe_ingredients m on m.recipe_version_id = new_id and m.ordinal = old_line.ordinal
      where ri.recipe_version_id = source_version;
  end if;
  return new_id;
end
$$;

create function purezza_private.create_recipe_version(source_version uuid, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  recipe uuid;
begin
  perform purezza_private.recipe_author_check();
  result_id := purezza_private.claim_operation('NOVA_VERSAO_RECEITA', request_id, jsonb_build_array(source_version));
  if result_id is not null then return result_id; end if;
  select recipe_id into recipe from public.recipe_versions where id = source_version;
  if recipe is null then raise exception using errcode = 'P0002', message = 'Versão de receita não encontrada.'; end if;
  if exists(select from public.recipe_versions where recipe_id = recipe and status = 'PENDENTE_VALIDACAO' and id <> source_version) then
    raise exception using errcode = '23505', message = 'Já existe uma versão em elaboração desta receita. Conclua ou exclua essa versão primeiro.';
  end if;
  if exists(select from public.recipe_versions where id = source_version and status = 'PENDENTE_VALIDACAO') then
    raise exception using errcode = '22023', message = 'Esta versão ainda está em elaboração. Edite a própria versão.';
  end if;
  result_id := purezza_private.copy_recipe_version(source_version, recipe);
  insert into public.audit_logs(actor, action, details) values(auth.uid(), 'NOVA_VERSAO_RECEITA',
    jsonb_build_object('entidade', 'VERSAO_RECEITA', 'registro_id', result_id, 'origem', source_version));
  update public.operation_requests set result = result_id
    where actor = auth.uid() and operation = 'NOVA_VERSAO_RECEITA' and operation_requests.request_id = create_recipe_version.request_id;
  return result_id;
end
$$;

create function purezza_private.duplicate_recipe(source_version uuid, input jsonb, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  recipe uuid;
  new_code text := nullif(btrim(input->>'code'), '');
  new_name text := nullif(btrim(input->>'name'), '');
begin
  perform purezza_private.recipe_author_check();
  if new_code is null or length(new_code) > 60 or new_name is null or length(new_name) > 180 then
    raise exception using errcode = '22023', message = 'Informe código (até 60) e nome (até 180 caracteres).';
  end if;
  result_id := purezza_private.claim_operation('DUPLICAR_RECEITA', request_id, jsonb_build_array(source_version, input));
  if result_id is not null then return result_id; end if;
  if not exists(select from public.recipe_versions where id = source_version) then
    raise exception using errcode = 'P0002', message = 'Versão de receita não encontrada.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('recipe/' || lower(new_code), 0));
  if exists(select from public.recipes where lower(btrim(code)) = lower(new_code)) then
    raise exception using errcode = '23505', message = 'Já existe uma receita com este código.';
  end if;
  insert into public.recipes(code, name) values(new_code, new_name) returning id into recipe;
  result_id := purezza_private.copy_recipe_version(source_version, recipe);
  insert into public.audit_logs(actor, action, details) values(auth.uid(), 'DUPLICAR_RECEITA',
    jsonb_build_object('entidade', 'VERSAO_RECEITA', 'registro_id', result_id, 'receita_id', recipe, 'codigo', new_code, 'origem', source_version));
  update public.operation_requests set result = result_id
    where actor = auth.uid() and operation = 'DUPLICAR_RECEITA' and operation_requests.request_id = duplicate_recipe.request_id;
  return result_id;
end
$$;

-- Exclui uma receita criada por engano: única versão, pendente, sem aprovação nem nenhum vínculo.
-- Revalida as dependências com a linha travada, na mesma transação.
create function purezza_private.delete_draft_recipe(target_version uuid, reason text, request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  v record;
begin
  perform purezza_private.catalog_authorize('VERSAO_RECEITA');
  result_id := purezza_private.claim_operation('EXCLUIR_RECEITA', request_id, jsonb_build_array(target_version, reason));
  if result_id is not null then return result_id; end if;
  select rv.id, rv.recipe_id, rv.status, r.code, r.name into v
    from public.recipe_versions rv join public.recipes r on r.id = rv.recipe_id where rv.id = target_version;
  if not found then raise exception using errcode = 'P0002', message = 'Receita não encontrada. Ela pode já ter sido excluída.'; end if;
  perform from public.recipes where id = v.recipe_id for update;
  perform from public.recipe_versions where recipe_id = v.recipe_id for update;
  if v.status <> 'PENDENTE_VALIDACAO' or (select count(*) from public.recipe_versions where recipe_id = v.recipe_id) <> 1
    or exists(select from purezza_private.catalog_dependency_rows('VERSAO_RECEITA', target_version)) then
    raise exception using errcode = '23503', message = 'Esta receita possui histórico de utilização e não pode ser excluída definitivamente.';
  end if;
  delete from public.recipe_review_ingredients where recipe_version_id = target_version;
  delete from public.recipe_reviews where recipe_version_id = target_version;
  delete from public.recipe_ingredients where recipe_version_id = target_version;
  delete from public.recipe_versions where id = target_version;
  delete from public.recipes where id = v.recipe_id;
  insert into public.audit_logs(actor, action, details) values(auth.uid(), 'EXCLUIR_CADASTRO',
    jsonb_build_object('entidade', 'RECEITA', 'registro_id', v.recipe_id, 'versao_id', target_version,
      'justificativa', nullif(btrim(reason), ''), 'registro', jsonb_build_object('codigo', v.code, 'nome', v.name), 'request_id', request_id));
  update public.operation_requests set result = target_version
    where actor = auth.uid() and operation = 'EXCLUIR_RECEITA' and operation_requests.request_id = delete_draft_recipe.request_id;
  return target_version;
end
$$;

create function public.create_recipe(input jsonb, request_id uuid) returns uuid
language sql set search_path = '' as $$ select purezza_private.create_recipe(input, request_id) $$;
create function public.create_recipe_version(source_version uuid, request_id uuid) returns uuid
language sql set search_path = '' as $$ select purezza_private.create_recipe_version(source_version, request_id) $$;
create function public.duplicate_recipe(source_version uuid, input jsonb, request_id uuid) returns uuid
language sql set search_path = '' as $$ select purezza_private.duplicate_recipe(source_version, input, request_id) $$;
create function public.delete_draft_recipe(target_version uuid, reason text, request_id uuid) returns uuid
language sql set search_path = '' as $$ select purezza_private.delete_draft_recipe(target_version, reason, request_id) $$;

revoke all on function
  purezza_private.recipe_author_check(), purezza_private.recipe_source_lines(jsonb), purezza_private.recipe_yields(jsonb),
  purezza_private.copy_recipe_version(uuid, uuid),
  purezza_private.create_recipe(jsonb, uuid), purezza_private.create_recipe_version(uuid, uuid),
  purezza_private.duplicate_recipe(uuid, jsonb, uuid), purezza_private.delete_draft_recipe(uuid, text, uuid),
  public.create_recipe(jsonb, uuid), public.create_recipe_version(uuid, uuid),
  public.duplicate_recipe(uuid, jsonb, uuid), public.delete_draft_recipe(uuid, text, uuid)
from public, anon, authenticated;
grant execute on function
  purezza_private.create_recipe(jsonb, uuid), purezza_private.create_recipe_version(uuid, uuid),
  purezza_private.duplicate_recipe(uuid, jsonb, uuid), purezza_private.delete_draft_recipe(uuid, text, uuid),
  public.create_recipe(jsonb, uuid), public.create_recipe_version(uuid, uuid),
  public.duplicate_recipe(uuid, jsonb, uuid), public.delete_draft_recipe(uuid, text, uuid)
to authenticated;
