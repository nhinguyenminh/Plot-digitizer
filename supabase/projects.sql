-- Private editable projects. Run once in the intended Supabase project.
create table if not exists public.plotline_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  project jsonb not null,
  updated_at timestamptz not null default clock_timestamp(),
  unique (owner_id, name)
);

alter table public.plotline_projects enable row level security;
revoke all on public.plotline_projects from public, anon;
grant select, insert, update, delete on public.plotline_projects to authenticated;

create policy "Users read their own projects" on public.plotline_projects
  for select to authenticated using (owner_id = auth.uid());
create policy "Users create their own projects" on public.plotline_projects
  for insert to authenticated with check (owner_id = auth.uid());
create policy "Users update their own projects" on public.plotline_projects
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "Users delete their own projects" on public.plotline_projects
  for delete to authenticated using (owner_id = auth.uid());

create or replace function public.plotline_project_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
create trigger plotline_project_updated_at before update on public.plotline_projects
  for each row execute function public.plotline_project_updated_at();
