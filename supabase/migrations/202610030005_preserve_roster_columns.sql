alter table public.event_participants
  add column rut text,
  add column age_bracket text;

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
  insert into public.event_participants(
    event_id, bib, chip, first_name, last_name, sex, distance, category, team, rut, age_bracket
  )
  select p_event_id,
    nullif(btrim(x.bib), ''),
    nullif(upper(regexp_replace(btrim(x.chip), '\s', '', 'g')), ''),
    btrim(x.first_name),
    nullif(btrim(x.last_name), ''),
    case when x.sex in ('F', 'M', 'otro', 'no_informado') then x.sex else null end,
    nullif(upper(btrim(x.distance)), ''),
    nullif(btrim(x.category), ''),
    nullif(btrim(x.team), ''),
    nullif(btrim(x.rut), ''),
    nullif(btrim(x.age_bracket), '')
  from jsonb_to_recordset(p_participants) as x(
    bib text, chip text, first_name text, last_name text, sex text,
    distance text, category text, team text, rut text, age_bracket text
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.import_event_participants(uuid, jsonb) from public, anon;
grant execute on function public.import_event_participants(uuid, jsonb) to authenticated;

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
from base b left join ranked r on r.participant_id = b.participant_id;
grant select on public.event_results to authenticated;
