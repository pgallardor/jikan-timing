create table public.event_distances (
  event_id uuid not null references public.events(id) on delete cascade,
  distance text not null check (char_length(btrim(distance)) between 1 and 30),
  official_start_at timestamptz,
  started_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (event_id, distance)
);

alter table public.event_participants add column distance text;

update public.event_participants p
set distance = upper(btrim((regexp_match(p.category, '^([0-9]+([.][0-9]+)?[[:space:]]*(KM|K|M))'))[1]))
where p.category is not null
  and p.category ~ '^[0-9]+([.][0-9]+)?[[:space:]]*(KM|K|M)';

insert into public.event_distances(event_id, distance)
select distinct event_id, distance
from public.event_participants
where distance is not null
on conflict (event_id, distance) do nothing;

alter table public.event_participants
  add constraint event_participant_distance_fk
  foreign key (event_id, distance) references public.event_distances(event_id, distance);

create or replace function public.ensure_event_distance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.distance is null and new.category is not null then
    new.distance := upper(btrim((regexp_match(new.category, '^([0-9]+([.][0-9]+)?[[:space:]]*(KM|K|M))'))[1]));
  end if;
  if new.distance is not null then
    new.distance := upper(btrim(new.distance));
    insert into public.event_distances(event_id, distance)
    values (new.event_id, new.distance)
    on conflict (event_id, distance) do nothing;
  end if;
  return new;
end;
$$;

create trigger event_participants_distance_group
before insert or update of event_id, distance, category on public.event_participants
for each row execute function public.ensure_event_distance();

alter table public.event_distances enable row level security;
revoke all on public.event_distances from public, anon;
grant select, insert, update, delete on public.event_distances to authenticated;

create policy "Owners manage event distances" on public.event_distances
  for all to authenticated
  using (public.owns_event(event_id))
  with check (public.owns_event(event_id));

alter table public.timing_entry_audit
  drop constraint if exists timing_entry_audit_action_check;
alter table public.timing_entry_audit
  add constraint timing_entry_audit_action_check
  check (action in ('manual_created', 'manual_corrected', 'manual_voided', 'rfid_accepted', 'rfid_ignored', 'official_distance_start'));

create or replace function public.import_event_participants(p_event_id uuid, p_participants jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null or not public.owns_event(p_event_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if jsonb_typeof(p_participants) is distinct from 'array' or jsonb_array_length(p_participants) not between 1 and 5000 then
    raise exception 'Import must contain between 1 and 5000 participants' using errcode = '22023';
  end if;
  insert into public.event_participants(event_id, bib, chip, first_name, last_name, sex, distance, category, team)
  select p_event_id,
    nullif(btrim(x.bib), ''),
    nullif(upper(regexp_replace(btrim(x.chip), '\s', '', 'g')), ''),
    btrim(x.first_name),
    nullif(btrim(x.last_name), ''),
    case when x.sex in ('F', 'M', 'otro', 'no_informado') then x.sex else null end,
    nullif(upper(btrim(x.distance)), ''),
    nullif(btrim(x.category), ''),
    nullif(btrim(x.team), '')
  from jsonb_to_recordset(p_participants) as x(
    bib text, chip text, first_name text, last_name text, sex text, distance text, category text, team text
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.import_event_participants(uuid, jsonb) from public, anon;
grant execute on function public.import_event_participants(uuid, jsonb) to authenticated;

create or replace function public.start_event_distance(p_event_id uuid, p_distance text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_official_start_at timestamptz;
  v_started_at timestamptz;
  v_start_at timestamptz;
  v_count integer;
begin
  if auth.uid() is null or not public.owns_event(p_event_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select d.official_start_at, d.started_at
  into v_official_start_at, v_started_at
  from public.event_distances d
  where d.event_id = p_event_id and d.distance = upper(btrim(p_distance))
  for update;
  if not found then
    raise exception 'Distance is not configured for this event' using errcode = 'P0002';
  end if;
  if v_started_at is not null then
    raise exception 'This distance has already started' using errcode = '23505';
  end if;
  if not exists (
    select 1 from public.event_participants p
    where p.event_id = p_event_id and p.distance = upper(btrim(p_distance))
  ) then
    raise exception 'This distance has no participants' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.timing_entries t
    join public.event_participants p on p.id = t.participant_id and p.event_id = t.event_id
    where t.event_id = p_event_id and t.stage = 'start' and p.distance = upper(btrim(p_distance))
  ) then
    raise exception 'A runner already has a start mark for this distance; reconcile it before starting the group' using errcode = '23505';
  end if;

  v_start_at := coalesce(v_official_start_at, now());
  with new_entries as (
    insert into public.timing_entries(event_id, participant_id, stage, captured_at, origin, operator_id)
    select p.event_id, p.id, 'start', v_start_at, 'manual', auth.uid()
    from public.event_participants p
    where p.event_id = p_event_id and p.distance = upper(btrim(p_distance))
    returning *
  )
  insert into public.timing_entry_audit(
    event_id, participant_id, stage, action, actor_type, actor_id, reason, after_entry
  )
  select n.event_id, n.participant_id, 'start', 'official_distance_start', 'operator', auth.uid(),
    'Inicio oficial de distancia ' || upper(btrim(p_distance)), to_jsonb(n)
  from new_entries n;
  get diagnostics v_count = row_count;

  update public.event_distances
  set started_at = v_start_at
  where event_id = p_event_id and distance = upper(btrim(p_distance));
  return v_count;
end;
$$;
revoke all on function public.start_event_distance(uuid, text) from public, anon;
grant execute on function public.start_event_distance(uuid, text) to authenticated;
