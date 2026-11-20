-- Run once in the Supabase SQL editor. This exposes anonymous model updates:
-- anyone with the publishable key can submit bounded updates.
create table if not exists public.plotline_learning_model (
  id integer primary key check (id = 1),
  weights double precision[] not null,
  samples integer not null default 0
);
create table if not exists public.plotline_learning_updates (
  id uuid primary key,
  delta double precision[] not null,
  created_at timestamptz not null default now()
);
insert into public.plotline_learning_model (id, weights)
values (1, array[-4, 0, 8, 0, 0, 0, 0, 0, 0]::double precision[])
on conflict (id) do nothing;

alter table public.plotline_learning_model enable row level security;
alter table public.plotline_learning_updates enable row level security;
revoke all on public.plotline_learning_model, public.plotline_learning_updates from public, anon, authenticated;

create or replace function public.plotline_get_learning_model()
returns jsonb language sql security definer set search_path = pg_catalog, public
as $$
  select jsonb_build_object('version', 1, 'weights', weights, 'samples', samples)
  from public.plotline_learning_model where id = 1;
$$;

create or replace function public.plotline_submit_learning_update(p_id uuid, p_delta double precision[])
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  inserted integer;
begin
  if p_id is null or p_delta is null or cardinality(p_delta) <> 9
     or array_ndims(p_delta) <> 1 or array_lower(p_delta, 1) <> 1
     or exists (select 1 from unnest(p_delta) as x where x is null or not (x between -0.5 and 0.5)) then
    raise exception 'Invalid learning update';
  end if;
  insert into public.plotline_learning_updates (id, delta) values (p_id, p_delta)
    on conflict (id) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 1 then
    update public.plotline_learning_model m
      set weights = array(select greatest(-16.0, least(16.0, m.weights[i] + p_delta[i]))
                          from generate_series(1, 9) as i),
          samples = m.samples + 1
      where m.id = 1;
  end if;
  return public.plotline_get_learning_model();
end;
$$;
revoke all on function public.plotline_get_learning_model() from public;
revoke all on function public.plotline_submit_learning_update(uuid, double precision[]) from public;
grant execute on function public.plotline_get_learning_model() to anon;
grant execute on function public.plotline_submit_learning_update(uuid, double precision[]) to anon;
