-- Apply after learning.sql. Existing models and pending legacy updates remain intact.
create table if not exists public.plotline_curve_comparisons (
  update_id uuid primary key references public.plotline_learning_updates(id),
  comparison jsonb not null
);
alter table public.plotline_curve_comparisons enable row level security;
revoke all on public.plotline_curve_comparisons from public, anon, authenticated;

create or replace function public.plotline_submit_curve_comparison(
  p_id uuid, p_delta double precision[], p_comparison jsonb
)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  result jsonb;
begin
  if jsonb_typeof(p_comparison) is distinct from 'object'
     or octet_length(p_comparison::text) > 2000000
     or p_comparison->'version' is distinct from '1'::jsonb
     or jsonb_typeof(p_comparison->'width') is distinct from 'number'
     or jsonb_typeof(p_comparison->'height') is distinct from 'number'
     or jsonb_typeof(p_comparison->'counts') is distinct from 'array'
     or jsonb_typeof(p_comparison->'examples') is distinct from 'array' then
    raise exception 'Invalid curve comparison';
  end if;
  if (p_comparison->>'width')::numeric not between 1 and 16000000
     or (p_comparison->>'height')::numeric not between 1 and 16000000
     or (p_comparison->>'width')::numeric * (p_comparison->>'height')::numeric > 16000000
     or jsonb_array_length(p_comparison->'counts') <> 4
     or jsonb_array_length(p_comparison->'examples') > 6000 then
    raise exception 'Invalid curve comparison dimensions';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_comparison->'counts') n
    where jsonb_typeof(n) <> 'number'
       or case when jsonb_typeof(n) = 'number' then (n::text)::numeric < 0 or (n::text)::numeric > 16000000 or trunc((n::text)::numeric) <> (n::text)::numeric else true end
  ) or exists (
    select 1 from jsonb_array_elements(p_comparison->'examples') e
    where jsonb_typeof(e) <> 'array'
       or case when jsonb_typeof(e) = 'array' then jsonb_array_length(e) <> 10 else true end
       or case when jsonb_typeof(e) = 'array' then exists (
         select 1 from jsonb_array_elements(e) with ordinality as v(n, i)
         where jsonb_typeof(n) <> 'number'
            or case when jsonb_typeof(n) = 'number' then (n::text)::numeric not between 0 and 1
                 or (i in (1, 2, 3, 10) and (n::text)::numeric not in (0, 1)) else true end
       ) else true end
  ) then
    raise exception 'Invalid curve comparison values';
  end if;
  result := public.plotline_submit_learning_update(p_id, p_delta);
  insert into public.plotline_curve_comparisons (update_id, comparison)
    values (p_id, p_comparison) on conflict (update_id) do nothing;
  return result;
end;
$$;
revoke all on function public.plotline_submit_curve_comparison(uuid, double precision[], jsonb) from public;
grant execute on function public.plotline_submit_curve_comparison(uuid, double precision[], jsonb) to anon;
