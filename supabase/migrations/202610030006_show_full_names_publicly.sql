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
  ),
  ranked as (
    select
      b.*,
      rank() over (partition by b.event_id order by b.elapsed_seconds) as overall_place,
      case when b.category is not null then
        rank() over (partition by b.event_id, b.category order by b.elapsed_seconds)
      end as category_place
    from base b
    where b.elapsed_seconds is not null
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
    r.overall_place,
    r.category_place
  from base b
  left join ranked r on r.participant_id = b.participant_id
  where b.public_token = p_public_token
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
      p.first_name,
      p.last_name,
      p.bib,
      p.category,
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
    select
      b.participant_id,
      rank() over (partition by b.event_id order by b.elapsed_seconds) as overall_place,
      case when b.category is not null then
        rank() over (partition by b.event_id, b.category order by b.elapsed_seconds)
      end as category_place
    from base b
    where b.elapsed_seconds is not null
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
    r.overall_place,
    r.category_place
  from base b
  left join ranked r on r.participant_id = b.participant_id
  order by r.overall_place nulls last, b.bib nulls last, b.first_name nulls last;
$$;
revoke all on function public.get_public_event_standing(text) from public;
grant execute on function public.get_public_event_standing(text) to anon, authenticated;
