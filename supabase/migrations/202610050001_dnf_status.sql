alter table public.event_participants
  add column dnf_at timestamptz;

alter table public.timing_entry_audit
  drop constraint if exists timing_entry_audit_action_check;
alter table public.timing_entry_audit
  add constraint timing_entry_audit_action_check
  check (action in (
    'manual_created', 'manual_corrected', 'manual_voided',
    'rfid_accepted', 'rfid_ignored', 'official_distance_start', 'dnf_marked'
  ));

create or replace function public.participant_result_status(
  p_chip text,
  p_start_at timestamptz,
  p_finish_at timestamptz,
  p_dnf_at timestamptz
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_dnf_at is not null and p_finish_at is null then 'DNF'
    when p_chip is null then 'SIN CHIP'
    when p_start_at is null then 'SIN SALIDA'
    when p_finish_at is null then 'EN CARRERA'
    else 'FINALIZÓ'
  end;
$$;
revoke all on function public.participant_result_status(text, timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function public.participant_result_status(text, timestamptz, timestamptz, timestamptz) to authenticated;

create or replace function public.mark_unfinished_participants_as_dnf(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_marked_count integer;
begin
  if auth.uid() is null or not public.owns_event(p_event_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  with marked as (
    update public.event_participants p
    set dnf_at = now()
    where p.event_id = p_event_id
      and p.dnf_at is null
      and not exists (
        select 1
        from public.timing_entries f
        where f.event_id = p.event_id
          and f.participant_id = p.id
          and f.stage = 'finish'
      )
    returning p.id, p.dnf_at
  ), audit_entries as (
    insert into public.timing_entry_audit (
      event_id, participant_id, stage, action, actor_type, actor_id,
      reason, before_entry, after_entry
    )
    select
      p_event_id, marked.id, 'finish', 'dnf_marked', 'operator', auth.uid(),
      'Marcado DNF en lote: sin llegada', null,
      jsonb_build_object('dnf_at', marked.dnf_at)
    from marked
    returning id
  )
  select count(*) into v_marked_count from marked;

  return v_marked_count;
end;
$$;
revoke all on function public.mark_unfinished_participants_as_dnf(uuid) from public, anon;
grant execute on function public.mark_unfinished_participants_as_dnf(uuid) to authenticated;

create or replace view public.event_results
with (security_invoker = true)
as
with base as (
  select
    p.event_id,
    p.id as participant_id,
    p.bib,
    p.chip,
    p.first_name,
    p.last_name,
    p.sex,
    p.category,
    p.team,
    p.public_token,
    s.captured_at as start_at,
    s.origin as start_origin,
    s.antenna as start_antenna,
    s.rssi as start_rssi,
    f.captured_at as finish_at,
    f.origin as finish_origin,
    f.antenna as finish_antenna,
    f.rssi as finish_rssi,
    public.participant_result_status(p.chip, s.captured_at, f.captured_at, p.dnf_at) as result_status,
    case when s.captured_at is not null and f.captured_at is not null
      then extract(epoch from (f.captured_at - s.captured_at)) end as elapsed_seconds,
    p.distance,
    p.rut,
    p.age_bracket
  from public.event_participants p
  left join public.timing_entries s on s.event_id = p.event_id and s.participant_id = p.id and s.stage = 'start'
  left join public.timing_entries f on f.event_id = p.event_id and f.participant_id = p.id and f.stage = 'finish'
),
ranked as (
  select places.*
  from (select distinct event_id from base) events
  cross join lateral public.event_participant_places(events.event_id) places
)
select
  b.event_id,
  b.participant_id,
  b.bib,
  b.chip,
  b.first_name,
  b.last_name,
  b.sex,
  b.category,
  b.team,
  b.public_token,
  b.start_at,
  b.start_origin,
  b.start_antenna,
  b.start_rssi,
  b.finish_at,
  b.finish_origin,
  b.finish_antenna,
  b.finish_rssi,
  b.result_status,
  b.elapsed_seconds,
  r.overall_place,
  r.category_place,
  b.distance,
  b.rut,
  b.age_bracket
from base b
left join ranked r on r.participant_id = b.participant_id;
grant select on public.event_results to authenticated;

create or replace function public.get_public_result_by_token(p_public_token text)
returns table (
  event_name text,
  event_slug text,
  event_status text,
  event_timezone text,
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
stable
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
      p.public_token,
      p.first_name,
      p.last_name,
      p.bib,
      p.category,
      p.distance,
      p.sex,
      case when p.id is null then null
        else public.participant_result_status(p.chip, s.captured_at, f.captured_at, p.dnf_at)
      end as result_status,
      s.captured_at as start_at,
      f.captured_at as finish_at,
      case when s.captured_at is not null and f.captured_at is not null
        then extract(epoch from (f.captured_at - s.captured_at)) end as elapsed_seconds
    from public.events e
    join public.event_participants p on p.event_id = e.id
    left join public.timing_entries s on s.event_id = e.id and s.participant_id = p.id and s.stage = 'start'
    left join public.timing_entries f on f.event_id = e.id and f.participant_id = p.id and f.stage = 'finish'
    where p.public_token = p_public_token
  )
  select
    b.event_name,
    b.event_slug,
    b.event_status,
    b.event_timezone,
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
  left join lateral public.event_participant_places(b.event_id) place
    on place.participant_id = b.participant_id
  limit 1;
$$;
revoke all on function public.get_public_result_by_token(text) from public;
grant execute on function public.get_public_result_by_token(text) to anon, authenticated;

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
stable
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
      case when p.id is null then null
        else public.participant_result_status(p.chip, s.captured_at, f.captured_at, p.dnf_at)
      end as result_status,
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
    cross join lateral public.event_participant_places(events.event_id) places
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
