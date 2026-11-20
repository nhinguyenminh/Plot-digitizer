-- Run once in the Supabase SQL editor to enable shared point-spacing learning.
create table if not exists public.plotline_point_spacing_model (
  id integer primary key check (id = 1),
  factor double precision not null check (factor between 1 and 1.2),
  samples integer not null default 0 check (samples >= 0)
);
create table if not exists public.plotline_point_spacing_updates (
  id uuid primary key,
  target double precision not null check (target between 1.05 and 1.2),
  created_at timestamptz not null default now()
);
insert into public.plotline_point_spacing_model (id, factor)
values (1, 1)
on conflict (id) do nothing;

alter table public.plotline_point_spacing_model enable row level security;
alter table public.plotline_point_spacing_updates enable row level security;
revoke all on public.plotline_point_spacing_model, public.plotline_point_spacing_updates from public, anon, authenticated;

create or replace function public.plotline_get_point_spacing_model()
returns jsonb language sql security definer set search_path = pg_catalog, public
as $$
  select jsonb_build_object('version', 1, 'factor', factor, 'samples', samples)
  from public.plotline_point_spacing_model where id = 1;
$$;

create or replace function public.plotline_submit_point_spacing_update(p_id uuid, p_target double precision)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  inserted integer;
begin
  if p_id is null or p_target is null or p_target < 1.05 or p_target > 1.2 then
    raise exception 'Invalid point-spacing update';
  end if;
  insert into public.plotline_point_spacing_updates (id, target) values (p_id, p_target)
    on conflict (id) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 1 then
    update public.plotline_point_spacing_model m
      set factor = case when m.samples = 0 then p_target else greatest(1.0, least(1.2, m.factor * 0.75 + p_target * 0.25)) end,
          samples = m.samples + 1
      where m.id = 1;
  end if;
  return public.plotline_get_point_spacing_model();
end;
$$;
revoke all on function public.plotline_get_point_spacing_model() from public;
revoke all on function public.plotline_submit_point_spacing_update(uuid, double precision) from public;
grant execute on function public.plotline_get_point_spacing_model() to anon;
grant execute on function public.plotline_submit_point_spacing_update(uuid, double precision) to anon;
