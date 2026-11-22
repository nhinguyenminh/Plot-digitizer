-- Run once in the Supabase SQL editor to enable shared interaction-learning sync.
-- Stores only bounded numeric model deltas and aggregate counts (no images or coordinates).
create table if not exists public.plotline_interaction_model (
  id integer primary key check (id = 1),
  feature_weights double precision[] not null check (cardinality(feature_weights) = 14),
  feature_samples integer not null default 0 check (feature_samples >= 0),
  spacing_factor double precision not null default 1 check (spacing_factor between 0.65 and 1.5),
  spacing_samples integer not null default 0 check (spacing_samples >= 0),
  curvature_bias double precision not null default 1 check (curvature_bias between 0.6 and 1.6),
  snap_radius double precision not null default 14 check (snap_radius between 8 and 26),
  snap_samples integer not null default 0 check (snap_samples >= 0),
  healing_scores double precision[] not null default array[0, 0, 0]::double precision[] check (cardinality(healing_scores) = 3),
  stats jsonb not null default '{"pointsAdded":0,"pointsMoved":0,"pointsDeleted":0,"pointsSnapped":0,"healingApplied":0,"paintSessions":0,"reconstructionEdits":0}'::jsonb,
  updated_at timestamptz
);

create table if not exists public.plotline_interaction_updates (
  id uuid primary key,
  update_payload jsonb not null,
  created_at timestamptz not null default now()
);

insert into public.plotline_interaction_model (id, feature_weights)
values (1, array[-3.6, 0.4, 7.2, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.3, 0, 0]::double precision[])
on conflict (id) do nothing;

alter table public.plotline_interaction_model enable row level security;
alter table public.plotline_interaction_updates enable row level security;
revoke all on public.plotline_interaction_model, public.plotline_interaction_updates from public, anon, authenticated;

create or replace function public.plotline_get_interaction_model()
returns jsonb language sql security definer set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'version', 1,
    'featureWeights', feature_weights,
    'featureSamples', feature_samples,
    'spacingFactor', spacing_factor,
    'spacingSamples', spacing_samples,
    'curvatureBias', curvature_bias,
    'snapRadius', snap_radius,
    'snapSamples', snap_samples,
    'healingScores', healing_scores,
    'stats', stats,
    'updatedAt', updated_at
  )
  from public.plotline_interaction_model where id = 1;
$$;

create or replace function public.plotline_submit_interaction_update(p_id uuid, p_update jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  inserted integer;
  v_feature_delta double precision[];
  v_feature_samples_delta integer;
  v_spacing_target double precision;
  v_curvature_delta double precision;
  v_snap_target double precision;
  v_healing_choice integer;
  v_stats_delta jsonb;
  v_added integer;
  v_moved integer;
  v_deleted integer;
  v_snapped integer;
  v_healed integer;
  v_paint integer;
  v_recon integer;
begin
  if p_id is null or p_update is null or jsonb_typeof(p_update) <> 'object' then
    raise exception 'Invalid interaction learning update';
  end if;

  if jsonb_typeof(p_update->'featureDelta') <> 'array' or jsonb_array_length(p_update->'featureDelta') <> 14 then
    raise exception 'Invalid interaction feature delta';
  end if;

  select array_agg(val::double precision order by ord)
    into v_feature_delta
  from jsonb_array_elements_text(p_update->'featureDelta') with ordinality as t(val, ord);

  if v_feature_delta is null or cardinality(v_feature_delta) <> 14
     or exists (select 1 from unnest(v_feature_delta) as x where x is null or not (x between -0.5 and 0.5)) then
    raise exception 'Invalid interaction feature delta bounds';
  end if;

  v_feature_samples_delta := coalesce((p_update->>'featureSamplesDelta')::integer, 0);
  if v_feature_samples_delta < 0 or v_feature_samples_delta > 50 then
    raise exception 'Invalid feature sample delta';
  end if;

  if p_update ? 'spacingTarget' and jsonb_typeof(p_update->'spacingTarget') <> 'null' then
    v_spacing_target := (p_update->>'spacingTarget')::double precision;
    if v_spacing_target is null or not (v_spacing_target between 0.65 and 1.5) then
      raise exception 'Invalid spacing target';
    end if;
  end if;

  v_curvature_delta := coalesce((p_update->>'curvatureDelta')::double precision, 0);
  if v_curvature_delta is null or not (v_curvature_delta between -0.2 and 0.2) then
    raise exception 'Invalid curvature delta';
  end if;

  if p_update ? 'snapTarget' and jsonb_typeof(p_update->'snapTarget') <> 'null' then
    v_snap_target := (p_update->>'snapTarget')::double precision;
    if v_snap_target is null or not (v_snap_target between 8 and 26) then
      raise exception 'Invalid snap target';
    end if;
  end if;

  if p_update ? 'healingChoice' and jsonb_typeof(p_update->'healingChoice') <> 'null' then
    v_healing_choice := (p_update->>'healingChoice')::integer;
    if v_healing_choice is null or v_healing_choice not in (0, 1, 2) then
      raise exception 'Invalid healing choice';
    end if;
  end if;

  v_stats_delta := coalesce(p_update->'statsDelta', '{}'::jsonb);
  if jsonb_typeof(v_stats_delta) <> 'object' then
    raise exception 'Invalid stats delta';
  end if;

  v_added := coalesce((v_stats_delta->>'pointsAdded')::integer, 0);
  v_moved := coalesce((v_stats_delta->>'pointsMoved')::integer, 0);
  v_deleted := coalesce((v_stats_delta->>'pointsDeleted')::integer, 0);
  v_snapped := coalesce((v_stats_delta->>'pointsSnapped')::integer, 0);
  v_healed := coalesce((v_stats_delta->>'healingApplied')::integer, 0);
  v_paint := coalesce((v_stats_delta->>'paintSessions')::integer, 0);
  v_recon := coalesce((v_stats_delta->>'reconstructionEdits')::integer, 0);

  if v_added < 0 or v_added > 1000 or v_moved < 0 or v_moved > 1000
     or v_deleted < 0 or v_deleted > 1000 or v_snapped < 0 or v_snapped > 1000
     or v_healed < 0 or v_healed > 100 or v_paint < 0 or v_paint > 100
     or v_recon < 0 or v_recon > 100 then
    raise exception 'Invalid stats delta bounds';
  end if;

  insert into public.plotline_interaction_updates (id, update_payload) values (p_id, p_update)
    on conflict (id) do nothing;
  get diagnostics inserted = row_count;

  if inserted = 1 then
    update public.plotline_interaction_model m
      set feature_weights = array(
            select greatest(-16.0, least(16.0, m.feature_weights[i] + v_feature_delta[i]))
            from generate_series(1, 14) as i
          ),
          feature_samples = m.feature_samples + v_feature_samples_delta,
          spacing_factor = case
            when v_spacing_target is null then m.spacing_factor
            when m.spacing_samples = 0 then greatest(0.65, least(1.5, v_spacing_target))
            else greatest(0.65, least(1.5, m.spacing_factor * 0.85 + v_spacing_target * 0.15))
          end,
          spacing_samples = m.spacing_samples + case when v_spacing_target is null then 0 else 1 end,
          curvature_bias = greatest(0.6, least(1.6, m.curvature_bias + v_curvature_delta)),
          snap_radius = case
            when v_snap_target is null then m.snap_radius
            when m.snap_samples = 0 then round(greatest(8.0, least(26.0, v_snap_target))::numeric, 1)::double precision
            else round(greatest(8.0, least(26.0, m.snap_radius * 0.8 + v_snap_target * 0.2))::numeric, 1)::double precision
          end,
          snap_samples = m.snap_samples + case when v_snap_target is null then 0 else 1 end,
          healing_scores = case
            when v_healing_choice is null then m.healing_scores
            else array(
              select round((m.healing_scores[i] * 0.92 + case when i = v_healing_choice + 1 then 1.0 else 0.0 end)::numeric, 3)::double precision
              from generate_series(1, 3) as i
            )
          end,
          stats = jsonb_build_object(
            'pointsAdded', coalesce((m.stats->>'pointsAdded')::integer, 0) + v_added,
            'pointsMoved', coalesce((m.stats->>'pointsMoved')::integer, 0) + v_moved,
            'pointsDeleted', coalesce((m.stats->>'pointsDeleted')::integer, 0) + v_deleted,
            'pointsSnapped', coalesce((m.stats->>'pointsSnapped')::integer, 0) + v_snapped,
            'healingApplied', coalesce((m.stats->>'healingApplied')::integer, 0) + v_healed,
            'paintSessions', coalesce((m.stats->>'paintSessions')::integer, 0) + v_paint,
            'reconstructionEdits', coalesce((m.stats->>'reconstructionEdits')::integer, 0) + v_recon
          ),
          updated_at = now()
      where m.id = 1;
  end if;

  return public.plotline_get_interaction_model();
end;
$$;

revoke all on function public.plotline_get_interaction_model() from public;
revoke all on function public.plotline_submit_interaction_update(uuid, jsonb) from public;
grant execute on function public.plotline_get_interaction_model() to anon, authenticated;
grant execute on function public.plotline_submit_interaction_update(uuid, jsonb) to anon, authenticated;
