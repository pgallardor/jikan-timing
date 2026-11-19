drop function public.get_public_result_by_token(text);
create function public.get_public_result_by_token(p_public_token text)
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
