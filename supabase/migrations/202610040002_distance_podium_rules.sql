create or replace function public.result_distance_key(p_distance text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when normalized.value in ('21K', '21KM') then '21KM'
    when normalized.value in ('10K', '10KM') then '10KM'
    else nullif(normalized.value, '')
  end
  from (
    select regexp_replace(upper(coalesce(p_distance, '')), '[^A-Z0-9]', '', 'g') as value
  ) normalized;
$$;
revoke all on function public.result_distance_key(text) from public, anon;
grant execute on function public.result_distance_key(text) to authenticated;

create or replace function public.event_participant_places(p_event_id uuid)
returns table (
  participant_id uuid,
  overall_place bigint,
  category_place bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select
      p.event_id,
      p.id as participant_id,
      p.sex,
      p.category,
      p.age_bracket,
      public.result_distance_key(p.distance) as distance_key,
      extract(epoch from (f.captured_at - s.captured_at)) as elapsed_seconds
    from public.event_participants p
    join public.timing_entries s
      on s.event_id = p.event_id and s.participant_id = p.id and s.stage = 'start'
    join public.timing_entries f
      on f.event_id = p.event_id and f.participant_id = p.id and f.stage = 'finish'
    where p.event_id = p_event_id
  ),
  gender_places as (
    select
      b.participant_id,
      rank() over (
        partition by b.event_id, b.distance_key, b.sex
        order by b.elapsed_seconds
      ) as gender_place
    from base b
    where b.distance_key in ('21KM', '10KM')
      and b.sex in ('F', 'M')
  ),
  overall_places as (
    select
      b.participant_id,
      rank() over (
        partition by b.event_id, b.distance_key
        order by b.elapsed_seconds
      ) as overall_place
    from base b
    where b.distance_key is not null
  ),
  category_places as (
    select
      b.participant_id,
      rank() over (
        partition by b.event_id, b.distance_key, b.sex, b.category
        order by b.elapsed_seconds
      ) as category_place
    from base b
    left join gender_places g on g.participant_id = b.participant_id
    where b.category is not null
      and b.distance_key is not null
      and not (
        b.distance_key in ('21KM', '10KM')
        and b.sex in ('F', 'M')
        and b.age_bracket is not null
        and coalesce(g.gender_place, 4) <= 3
      )
  )
  select o.participant_id, o.overall_place, c.category_place
  from overall_places o
  left join category_places c on c.participant_id = o.participant_id;
$$;
revoke all on function public.event_participant_places(uuid) from public, anon;
grant execute on function public.event_participant_places(uuid) to authenticated;

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
    case
      when p.chip is null then 'SIN CHIP'
      when s.captured_at is null then 'SIN SALIDA'
      when f.captured_at is null then 'EN CARRERA'
      else 'FINALIZÓ'
    end as result_status,
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
  category_place bigint
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
      case
        when p.chip is null then 'SIN CHIP'
        when s.captured_at is null then 'SIN SALIDA'
        when f.captured_at is null then 'EN CARRERA'
        else 'FINALIZÓ'
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
    place.category_place
  from base b
  left join lateral public.event_participant_places(b.event_id) place
    on place.participant_id = b.participant_id
  limit 1;
$$;
revoke all on function public.get_public_result_by_token(text) from public;
grant execute on function public.get_public_result_by_token(text) to anon, authenticated;

drop function public.get_public_event_standing(text);
create function public.get_public_event_standing(p_event_slug text)
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
  distance text
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
      case
        when p.id is null then null
        when p.chip is null then 'SIN CHIP'
        when s.captured_at is null then 'SIN SALIDA'
        when f.captured_at is null then 'EN CARRERA'
        else 'FINALIZÓ'
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
    b.distance
  from base b
  left join ranked place
    on place.participant_id = b.participant_id
  order by public.result_distance_key(b.distance) nulls last,
    place.overall_place nulls last, b.bib nulls last, b.first_name nulls last;
$$;
revoke all on function public.get_public_event_standing(text) from public;
grant execute on function public.get_public_event_standing(text) to anon, authenticated;
