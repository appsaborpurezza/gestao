create function purezza_private.import_preliminary(products jsonb, formulas jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  imported_products integer;
  imported_versions integer := 0;
  formula jsonb;
  target_recipe uuid;
  target_version uuid;
  summary jsonb;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'A importação exige perfil administrador ativo.';
  end if;

  if products is null or formulas is null
    or jsonb_typeof(products) <> 'array' or jsonb_typeof(formulas) <> 'array'
    or jsonb_array_length(products) + jsonb_array_length(formulas) = 0 then
    raise exception using errcode = '22023', message = 'Informe listas válidas para a importação.';
  end if;

  if exists (
    select from jsonb_array_elements(products) as product
    group by product->>'codigo_original' having count(*) > 1
  ) or exists (
    select from jsonb_array_elements(formulas) as recipe
    group by recipe->>'codigo', (recipe->>'versao')::integer having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Há códigos ou versões duplicados no arquivo.';
  end if;

  insert into public.items (original_code, original_description, classification)
  select product->>'codigo_original', product->>'descricao_original', product->>'classificacao_preliminar'
  from jsonb_array_elements(products) as product
  order by product->>'codigo_original'
  on conflict (original_code) do nothing;
  get diagnostics imported_products = row_count;

  for formula in select value from jsonb_array_elements(formulas) order by value->>'codigo', (value->>'versao')::integer loop
    if formula->>'status' is distinct from 'PENDENTE_VALIDACAO'
      or coalesce(jsonb_typeof(formula->'ingredientes'), '') <> 'array'
      or jsonb_array_length(formula->'ingredientes') = 0 then
      raise exception using errcode = '22023', message = 'A receita deve ter ingredientes e estar pendente de validação.';
    end if;

    insert into public.recipes (code, name)
    values (formula->>'codigo', formula->>'nome')
    on conflict (code) do nothing;

    select id into strict target_recipe from public.recipes where code = formula->>'codigo';

    insert into public.recipe_versions (recipe_id, version, yield_min, yield_target, yield_max)
    values (target_recipe, (formula->>'versao')::integer,
      (formula #>> '{rendimento_kg,minimo}')::numeric,
      (formula #>> '{rendimento_kg,medio}')::numeric,
      (formula #>> '{rendimento_kg,maximo}')::numeric)
    on conflict (recipe_id, version) do nothing returning id into target_version;

    if target_version is not null then
      insert into public.recipe_ingredients (recipe_version_id, source_name, ordinal, quantity, unit, stage, tolerance)
      select target_version, ingredient->>'nome', ordinal, (ingredient->>'quantidade')::numeric,
        ingredient->>'unidade', ingredient->>'etapa', (ingredient->>'tolerancia')::numeric
      from jsonb_array_elements(formula->'ingredientes') with ordinality as source(ingredient, ordinal);
      imported_versions := imported_versions + 1;
    end if;
  end loop;

  summary := jsonb_build_object(
    'produtos_inseridos', imported_products,
    'produtos_existentes', jsonb_array_length(products) - imported_products,
    'versoes_inseridas', imported_versions,
    'versoes_existentes', jsonb_array_length(formulas) - imported_versions
  );

  if imported_products + imported_versions > 0 then
    insert into public.audit_logs (actor, action, details)
    values (auth.uid(), 'IMPORTACAO_PRELIMINAR', summary);
  end if;
  return summary;
end
$$;

revoke all on function purezza_private.import_preliminary(jsonb, jsonb) from public, anon, authenticated;
grant execute on function purezza_private.import_preliminary(jsonb, jsonb) to authenticated;

create function public.import_preliminary(products jsonb, formulas jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select purezza_private.import_preliminary(products, formulas)
$$;
revoke all on function public.import_preliminary(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.import_preliminary(jsonb, jsonb) to authenticated;
