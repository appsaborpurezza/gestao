alter table public.locations add column version int not null default 1 check (version > 0);
alter table public.suppliers add column version int not null default 1 check (version > 0);
alter table public.manufacturers add column version int not null default 1 check (version > 0);
alter table public.items add column catalog_version int not null default 1 check (catalog_version > 0);

create function purezza_private.save_operational_catalog(
  catalog text, target uuid, expected_version int, input jsonb, request_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  result_id uuid;
  relation text;
  field_name text;
  new_label text;
  new_code text;
  new_unit text;
  is_active boolean;
  existing_version int;
  duplicate boolean;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode = '42501', message = 'Somente Administração pode alterar estes cadastros.';
  end if;

  select mapping.relation, mapping.field_name into relation, field_name from (values
    ('FORNECEDOR','suppliers','name'),('FABRICANTE','manufacturers','name'),
    ('LOCAL','locations','code'),('INSUMO','items','original_description')
  ) mapping(kind,relation,field_name) where mapping.kind = catalog;
  if relation is null or jsonb_typeof(input) is distinct from 'object'
    or jsonb_typeof(input->'active') is distinct from 'boolean' then
    raise exception using errcode = '22023', message = 'Informe o cadastro e o estado ativo.';
  end if;
  new_label := nullif(btrim(input->>'label'),'');
  new_code := nullif(btrim(input->>'code'),'');
  new_unit := nullif(btrim(input->>'unit'),'');
  is_active := (input->>'active')::boolean;
  if new_label is null or length(new_label) > (case when catalog = 'LOCAL' then 60 else 180 end) then
    raise exception using errcode = '22023', message = 'Informe um nome ou código de tamanho válido.';
  end if;

  result_id := purezza_private.claim_operation('SALVAR_CADASTRO_OPERACIONAL',request_id,
    jsonb_build_array(catalog,target,expected_version,input));
  if result_id is not null then return result_id; end if;

  if catalog = 'INSUMO' then
    if target is null then
      if new_code is null or length(new_code) > 60 or new_unit is null or new_unit not in ('kg','g','un','L','mL') then
        raise exception using errcode = '22023', message = 'Informe o código e a unidade base conferida do insumo.';
      end if;
      insert into public.items(original_code,original_description,classification,base_unit,active)
        values(new_code,new_label,'INSUMO',new_unit,is_active) returning id into result_id;
    else
      update public.items set commercial_description = new_label, active = is_active, catalog_version = catalog_version + 1
        where id = target and classification = 'INSUMO' and catalog_version = expected_version returning id into result_id;
    end if;
  else
    if target is not null then
      execute format('select version from public.%I where id = $1 for update',relation)
        into existing_version using target;
      if existing_version is null or existing_version is distinct from expected_version then
        raise exception using errcode = '40001', message = 'O cadastro mudou. Atualize a consulta.';
      end if;
    end if;
    if catalog = 'LOCAL' and not is_active and target is not null and (
      exists(select from public.stock_balances where location_id = target and quantity > 0)
      or exists(select from public.inventory_sessions where location_id = target and closed_at is null)
    ) then
      raise exception using errcode = '22023', message = 'O local tem saldo físico ou uma sessão de inventário aberta.';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(catalog || '/' || lower(new_label),0));
    execute format('select exists(select from public.%I where lower(btrim(%I)) = lower($1) and id is distinct from $2)',
      relation,field_name) into duplicate using new_label,target;
    if duplicate then
      raise exception using errcode = '23505', message = 'Já existe um cadastro com este nome ou código.';
    end if;

    if target is null then
      execute format('insert into public.%I(%I,active) values($1,$2) returning id',relation,field_name)
        into result_id using new_label,is_active;
    else
      execute format('update public.%I set %I=$1,active=$2,version=version+1 where id=$3 returning id',relation,field_name)
        into result_id using new_label,is_active,target;
    end if;
  end if;
  if result_id is null then
    raise exception using errcode = '40001', message = 'O cadastro mudou. Atualize a consulta.';
  end if;

  insert into public.audit_logs(actor,action,details) values(auth.uid(),'SALVAR_CADASTRO_OPERACIONAL',
    jsonb_build_object('tipo',catalog,'registro_id',result_id,'criacao',target is null,'ativo',is_active));
  update public.operation_requests set result = result_id
    where actor = auth.uid() and operation = 'SALVAR_CADASTRO_OPERACIONAL'
      and operation_requests.request_id = save_operational_catalog.request_id;
  return result_id;
end
$$;

create function public.save_operational_catalog(catalog text, target uuid, expected_version int, input jsonb, request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.save_operational_catalog(catalog,target,expected_version,input,request_id)
$$;
revoke all on function purezza_private.save_operational_catalog(text,uuid,int,jsonb,uuid),
  public.save_operational_catalog(text,uuid,int,jsonb,uuid) from public, anon, authenticated;
grant execute on function purezza_private.save_operational_catalog(text,uuid,int,jsonb,uuid),
  public.save_operational_catalog(text,uuid,int,jsonb,uuid) to authenticated;
