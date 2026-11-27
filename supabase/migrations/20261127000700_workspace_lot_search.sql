create or replace function public.workspace_search(search_text text, page_offset integer default 0)
returns table(module text, record_id uuid, label text, reference text)
language plpgsql stable security invoker set search_path = '' as $$
declare
  accents constant text := 'áàãâäéèêëíìîïóòõôöúùûüç';
  plain constant text := 'aaaaaeeeeiiiiooooouuuuc';
  needle text := translate(lower(btrim(coalesce(search_text,''))),accents,plain);
  commercial boolean := purezza_private.has_role('ADMINISTRADOR','VENDAS');
  technical boolean := purezza_private.has_role('ADMINISTRADOR','PRODUCAO');
begin
  if not (commercial or technical) then
    raise exception using errcode='42501',message='Seu perfil não pode pesquisar registros.';
  end if;
  if page_offset is null or page_offset<0 or char_length(needle) not between 2 and 100 then
    raise exception using errcode='22023',message='Confira o termo e a página da busca.';
  end if;
  return query
  with matches as (
    select 'products'::text section,i.id,
      coalesce(i.commercial_description,i.original_description) title,i.original_code ref
    from public.items i
    where strpos(translate(lower(concat_ws(' ',i.original_code,i.original_description,i.commercial_description)),accents,plain),needle)>0
    union all
    select 'customers',c.id,c.legal_name,c.customer_number::text from public.customers c
    where commercial and strpos(translate(lower(concat_ws(' ',c.customer_number,c.legal_name,c.trade_name)),accents,plain),needle)>0
    union all
    select 'orders',o.id,o.customer_name,o.order_number::text from public.orders o
    where commercial and strpos(translate(lower(concat_ws(' ',o.order_number,o.customer_name)),accents,plain),needle)>0
    union all
    select 'recipes',r.id,r.name,r.code from public.recipes r
    where technical and strpos(translate(lower(concat_ws(' ',r.code,r.name)),accents,plain),needle)>0
    union all
    select 'traceability',l.id,coalesce(i.commercial_description,i.original_description),l.internal_code
    from public.inventory_lots l
    join public.items i on i.id=l.item_id
    left join public.manufacturers m on m.id=l.manufacturer_id
    where technical and strpos(translate(lower(concat_ws(' ',l.internal_code,l.original_lot,
      i.original_code,i.original_description,i.commercial_description,m.name)),accents,plain),needle)>0
  )
  select section,id,title,ref from matches order by section,lower(title),ref,id limit 17 offset page_offset;
end
$$;
revoke all on function public.workspace_search(text,integer) from public,anon,authenticated;
grant execute on function public.workspace_search(text,integer) to authenticated;
