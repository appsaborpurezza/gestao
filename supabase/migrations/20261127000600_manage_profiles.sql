alter table public.profiles add column profile_version integer not null default 1;

create function purezza_private.manage_profile(target uuid, expected_version integer, name text,
  next_role public.app_role, next_active boolean, release_lot boolean, approve_recipe boolean)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid := auth.uid();
  previous public.profiles%rowtype;
  cleaned text := btrim(name);
  next_version integer;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode='42501',message='Somente Administração pode gerenciar perfis.';
  end if;
  if target is null or expected_version is null or cleaned is null or char_length(cleaned) not between 1 and 120
    or next_role is null or next_active is null or release_lot is null or approve_recipe is null then
    raise exception using errcode='22023',message='Confira os dados do perfil.';
  end if;
  -- Serialize grants and revocations, rechecking the actor after obtaining the lock.
  perform pg_advisory_xact_lock(553421,6);
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode='42501',message='Somente Administração pode gerenciar perfis.';
  end if;
  select * into previous from public.profiles where id=target for update;
  if not found or previous.profile_version<>expected_version then
    raise exception using errcode='40001',message='O perfil mudou. Atualize a consulta antes de salvar.';
  end if;
  if target=actor_id and (previous.role,previous.active,previous.can_release_lot,previous.can_approve_recipe)
    is distinct from (next_role,next_active,release_lot,approve_recipe) then
    raise exception using errcode='42501',message='Solicite a outro administrador a alteração de suas permissões.';
  end if;
  if previous.active and previous.role='ADMINISTRADOR' and (not next_active or next_role<>'ADMINISTRADOR')
    and not exists(select from public.profiles where id<>target and active and role='ADMINISTRADOR') then
    raise exception using errcode='23514',message='Mantenha pelo menos um administrador ativo.';
  end if;
  if (previous.display_name,previous.role,previous.active,previous.can_release_lot,previous.can_approve_recipe)
    is not distinct from (cleaned,next_role,next_active,release_lot,approve_recipe) then
    return previous.profile_version;
  end if;
  update public.profiles set display_name=cleaned,role=next_role,active=next_active,
    can_release_lot=release_lot,can_approve_recipe=approve_recipe,profile_version=previous.profile_version+1
  where id=target returning profile_version into next_version;
  insert into public.audit_logs(actor,action,details) values(actor_id,'GERENCIAR_PERFIL',jsonb_build_object(
    'perfil_id',target,'versao',next_version,
    'antes',jsonb_build_object('nome',previous.display_name,'perfil',previous.role,'ativo',previous.active,
      'libera_lote',previous.can_release_lot,'aprova_receita',previous.can_approve_recipe),
    'depois',jsonb_build_object('nome',cleaned,'perfil',next_role,'ativo',next_active,
      'libera_lote',release_lot,'aprova_receita',approve_recipe)));
  return next_version;
end
$$;

create function public.manage_profile(target uuid, expected_version integer, name text,
  next_role public.app_role, next_active boolean, release_lot boolean, approve_recipe boolean)
returns integer language sql security invoker set search_path = '' as $$
  select purezza_private.manage_profile(target,expected_version,name,next_role,next_active,release_lot,approve_recipe)
$$;
revoke all on function public.manage_profile(uuid,integer,text,public.app_role,boolean,boolean,boolean),
  purezza_private.manage_profile(uuid,integer,text,public.app_role,boolean,boolean,boolean) from public,anon,authenticated;
grant execute on function public.manage_profile(uuid,integer,text,public.app_role,boolean,boolean,boolean),
  purezza_private.manage_profile(uuid,integer,text,public.app_role,boolean,boolean,boolean) to authenticated;

create function purezza_private.link_auth_profile(email_address text, name text, assigned_role public.app_role)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid := auth.uid();
  target uuid;
begin
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode='42501',message='Somente Administração pode vincular perfis.';
  end if;
  perform pg_advisory_xact_lock(553421,6);
  if not purezza_private.has_role('ADMINISTRADOR') then
    raise exception using errcode='42501',message='Somente Administração pode vincular perfis.';
  end if;
  if assigned_role is null or name is null or char_length(btrim(name)) not between 1 and 120
    or email_address is null or char_length(btrim(email_address)) not between 3 and 254 then
    raise exception using errcode='22023',message='Confira os dados do perfil.';
  end if;
  select u.id into target from auth.users u
  where lower(u.email)=lower(btrim(email_address)) and u.email_confirmed_at is not null and not u.is_anonymous;
  if not found then
    raise exception using errcode='22023',message='Conta confirmada não encontrada no Auth.';
  end if;
  insert into public.profiles(id,display_name,role) values(target,btrim(name),assigned_role) on conflict(id) do nothing;
  if not found then raise exception using errcode='23505',message='A conta já possui perfil.'; end if;
  insert into public.audit_logs(actor,action,details) values(actor_id,'VINCULAR_PERFIL',
    jsonb_build_object('perfil_id',target,'perfil',assigned_role));
  return target;
end
$$;

create function public.link_auth_profile(email_address text,name text,assigned_role public.app_role)
returns uuid language sql security invoker set search_path = '' as $$
  select purezza_private.link_auth_profile(email_address,name,assigned_role)
$$;
revoke all on function public.link_auth_profile(text,text,public.app_role),
  purezza_private.link_auth_profile(text,text,public.app_role) from public,anon,authenticated;
grant execute on function public.link_auth_profile(text,text,public.app_role),
  purezza_private.link_auth_profile(text,text,public.app_role) to authenticated;
