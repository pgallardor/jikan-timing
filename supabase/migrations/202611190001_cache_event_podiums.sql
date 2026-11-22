create table public.event_podium_snapshots (
  event_id uuid primary key references public.events(id) on delete cascade,
  places jsonb not null default '{}'::jsonb,
  dirty boolean not null default true,
  computed_at timestamptz
);

alter table public.event_podium_snapshots enable row level security;
revoke all on public.event_podium_snapshots from public, anon, authenticated, service_role;

create or replace function public.mark_event_podium_snapshot_dirty_for_id(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_event_id is null then return; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_event_id::text, 0));
  if exists (select 1 from public.events e where e.id = p_event_id) then
    insert into public.event_podium_snapshots(event_id, places, dirty, computed_at)
    values (p_event_id, '{}'::jsonb, true, null)
    on conflict (event_id) do update set dirty = true
    where public.event_podium_snapshots.dirty is distinct from true;
  end if;
end;
$$;
revoke all on function public.mark_event_podium_snapshot_dirty_for_id(uuid) from public, anon, authenticated, service_role;

create or replace function public.mark_event_podium_snapshot_dirty()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.mark_event_podium_snapshot_dirty_for_id(old.event_id);
    return old;
  end if;

  if tg_op = 'UPDATE' and old.event_id is distinct from new.event_id then
    perform public.mark_event_podium_snapshot_dirty_for_id(old.event_id);
  end if;
  perform public.mark_event_podium_snapshot_dirty_for_id(new.event_id);
  return new;
end;
$$;
revoke all on function public.mark_event_podium_snapshot_dirty() from public, anon, authenticated, service_role;

create trigger event_participants_podium_snapshot_dirty_insert_delete
after insert or delete on public.event_participants
for each row execute function public.mark_event_podium_snapshot_dirty();

create trigger event_participants_podium_snapshot_dirty_update
after update of event_id, distance, sex, category, age_bracket on public.event_participants
for each row execute function public.mark_event_podium_snapshot_dirty();

create trigger timing_entries_podium_snapshot_dirty_insert_delete
after insert or delete on public.timing_entries
for each row execute function public.mark_event_podium_snapshot_dirty();

create trigger timing_entries_podium_snapshot_dirty_update
after update of event_id, participant_id, stage, captured_at on public.timing_entries
for each row execute function public.mark_event_podium_snapshot_dirty();

create trigger event_distances_podium_snapshot_dirty_insert_delete
after insert or delete on public.event_distances
for each row execute function public.mark_event_podium_snapshot_dirty();

create trigger event_distances_podium_snapshot_dirty_update
after update of event_id, distance, exclude_general_top3_from_categories, award_policy_configured
on public.event_distances
for each row execute function public.mark_event_podium_snapshot_dirty();

create or replace function public.calculate_event_participant_places(p_event_id uuid)
returns table (participant_id uuid, overall_place bigint, category_place bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select p.event_id, p.id as participant_id, p.sex, p.category, p.age_bracket,
      public.result_distance_key(p.distance) as distance_key,
      extract(epoch from (f.captured_at - s.captured_at)) as elapsed_seconds
    from public.event_participants p
    join public.timing_entries s on s.event_id = p.event_id and s.participant_id = p.id and s.stage = 'start'
    join public.timing_entries f on f.event_id = p.event_id and f.participant_id = p.id and f.stage = 'finish'
    where p.event_id = p_event_id
  ),
  overall_places as (
    select b.participant_id,
      rank() over (partition by b.event_id, b.distance_key, b.sex order by b.elapsed_seconds) as overall_place
    from base b
    where b.distance_key is not null
  ),
  category_places as (
    select b.participant_id,
      rank() over (partition by b.event_id, b.distance_key, b.sex, b.category order by b.elapsed_seconds) as category_place
    from base b
    join public.event_distances d on d.event_id = b.event_id and public.result_distance_key(d.distance) = b.distance_key
    left join overall_places o on o.participant_id = b.participant_id
    where b.category is not null and b.distance_key is not null
      and not (d.award_policy_configured and d.exclude_general_top3_from_categories
        and b.age_bracket is not null and coalesce(o.overall_place, 4) <= 3)
  )
  select o.participant_id, o.overall_place, c.category_place
  from overall_places o left join category_places c on c.participant_id = o.participant_id;
$$;
revoke all on function public.calculate_event_participant_places(uuid) from public, anon, authenticated, service_role;

create or replace function public.get_event_podium_snapshot(p_event_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_places jsonb;
  v_dirty boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_event_id::text, 0));

  select snapshot.places, snapshot.dirty
  into v_places, v_dirty
  from public.event_podium_snapshots snapshot
  where snapshot.event_id = p_event_id;

  if not found or v_dirty then
    select coalesce(
      jsonb_object_agg(calculated.participant_id::text, jsonb_build_object(
        'overall_place', calculated.overall_place,
        'category_place', calculated.category_place
      )),
      '{}'::jsonb
    )
    into v_places
    from public.calculate_event_participant_places(p_event_id) calculated;

    insert into public.event_podium_snapshots(event_id, places, dirty, computed_at)
    values (p_event_id, v_places, false, now())
    on conflict (event_id) do update
      set places = excluded.places,
          dirty = false,
          computed_at = excluded.computed_at;
  end if;

  return coalesce(v_places, '{}'::jsonb);
end;
$$;
revoke all on function public.get_event_podium_snapshot(uuid) from public, anon, authenticated, service_role;

create or replace function public.get_cached_event_participant_places(p_event_id uuid)
returns table (participant_id uuid, overall_place bigint, category_place bigint)
language sql
volatile
security definer
set search_path = ''
as $$
  select
    place.key::uuid,
    nullif(place.value->>'overall_place', '')::bigint,
    nullif(place.value->>'category_place', '')::bigint
  from jsonb_each(public.get_event_podium_snapshot(p_event_id)) as place(key, value);
$$;
revoke all on function public.get_cached_event_participant_places(uuid) from public, anon, authenticated, service_role;

create or replace function public.get_cached_event_participant_place(p_event_id uuid, p_participant_id uuid)
returns table (participant_id uuid, overall_place bigint, category_place bigint)
language sql
volatile
security definer
set search_path = ''
as $$
  select
    p_participant_id,
    nullif(place.value->>'overall_place', '')::bigint,
    nullif(place.value->>'category_place', '')::bigint
  from (select public.get_event_podium_snapshot(p_event_id) as places) snapshot
  cross join lateral (select snapshot.places->p_participant_id::text as value) place
  where snapshot.places ? p_participant_id::text;
$$;
revoke all on function public.get_cached_event_participant_place(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.event_participant_places(p_event_id uuid)
returns table (participant_id uuid, overall_place bigint, category_place bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    if not exists (
      select 1 from public.events e where e.id = p_event_id and e.owner_id = auth.uid()
    ) then
      raise exception 'Not authorized' using errcode = '42501';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' and session_user <> 'postgres' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query select * from public.get_cached_event_participant_places(p_event_id);
end;
$$;
revoke all on function public.event_participant_places(uuid) from public, anon, service_role;
grant execute on function public.event_participant_places(uuid) to authenticated;

create or replace function public.get_public_event_standing(p_event_slug text)
returns table (
  event_name text,
  event_slug text,
  event_status text,
  event_timezone text,
  participant_exists boolean,
  participant_name text,
  bib text,
  category text,
  result_status text,
  start_at timestamptz,
  finish_at timestamptz,
  elapsed_seconds numeric,
  overall_place bigint,
  category_place bigint,
  distance text,
  sex text
)
language sql
volatile
security definer
set search_path = ''
as $$
  with base as (
    select
      e.id as event_id,
      e.name as event_name,
      e.slug as event_slug,
      e.status as event_status,
      e.timezone as event_timezone,
      e.qr_show_name,
      e.qr_show_bib,
      e.qr_show_category,
      p.id as participant_id,
      p.first_name,
      p.last_name,
      p.bib,
      p.category,
      p.distance,
      p.sex,
      public.participant_result_status(p.chip, s.captured_at, f.captured_at, p.dnf_at) as result_status,
      s.captured_at as start_at,
      f.captured_at as finish_at,
      case when s.captured_at is not null and f.captured_at is not null
        then extract(epoch from (f.captured_at - s.captured_at)) end as elapsed_seconds
    from public.events e
    left join public.event_participants p on p.event_id = e.id
    left join public.timing_entries s on s.event_id = e.id and s.participant_id = p.id and s.stage = 'start'
    left join public.timing_entries f on f.event_id = e.id and f.participant_id = p.id and f.stage = 'finish'
    where e.slug = p_event_slug
  ),
  ranked as (
    select places.*
    from (select distinct event_id from base where event_id is not null) events
    cross join lateral public.get_cached_event_participant_places(events.event_id) places
  )
  select
    b.event_name,
    b.event_slug,
    b.event_status,
    b.event_timezone,
    b.participant_id is not null,
    case when b.qr_show_name then concat_ws(' ', b.first_name, b.last_name) else null end,
    case when b.qr_show_bib then b.bib else null end,
    case when b.qr_show_category then b.category else null end,
    b.result_status,
    b.start_at,
    b.finish_at,
    b.elapsed_seconds,
    place.overall_place,
    place.category_place,
    b.distance,
    b.sex
  from base b
  left join ranked place on place.participant_id = b.participant_id
  order by public.result_distance_key(b.distance) nulls last,
    case b.sex when 'F' then 1 when 'M' then 2 when 'otro' then 3 when 'no_informado' then 4 else 5 end,
    place.overall_place nulls last, b.bib nulls last, b.first_name nulls last;
$$;
revoke all on function public.get_public_event_standing(text) from public;
grant execute on function public.get_public_event_standing(text) to anon, authenticated;
