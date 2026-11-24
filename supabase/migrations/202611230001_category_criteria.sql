begin;

-- Classification is derived from criteria. Retain imported labels as provenance.
-- A prepared offline package must be published/released before this upgrade.
lock table public.events in share row exclusive mode;
do $$ begin
  if exists(select 1 from public.events where local_operation_status in ('prepared','active')) then
    raise exception 'Release or finish outstanding local preparations before upgrading category criteria' using errcode='55000';
  end if;
end $$;
alter table public.event_distances add column category_criteria text[] not null default array['sex','age_bracket'],
  add column category_policy_version text not null default 'category_criteria_v1';
alter table public.event_distances add constraint supported_category_criteria
  check (category_criteria = array['sex','age_bracket'] and category_policy_version = 'category_criteria_v1');

create function public.result_age_group(p_value text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := regexp_replace(btrim(normalize(coalesce(p_value,''), NFC)), '\s+', ' ', 'g'); m text[];
begin
  if v = '' then return null; end if;
  m := regexp_match(v, '^(\d{1,3})\s*(?:a|al|hasta|[-–—])\s*(\d{1,3})(?:\s*(?:años?|anos?))?$', 'i');
  if m is not null then
    if m[1]::int > m[2]::int or m[2]::int > 120 then return null; end if;
    return m[1]::int || ' a ' || m[2]::int || ' años';
  end if;
  if v ~ '^\d+$' then return null; end if;
  return upper(v);
end;
$$;

create function public.result_category_key(p_sex text, p_age_group text) returns text
language sql immutable set search_path = '' as $$
  select case when p_sex in ('F','M','otro') and public.result_age_group(p_age_group) is not null
    then jsonb_build_array(p_sex,public.result_age_group(p_age_group))::text end;
$$;
create function public.result_category_label(p_sex text, p_age_group text) returns text
language sql immutable set search_path = '' as $$
  select case when public.result_category_key(p_sex,p_age_group) is not null
    then (case p_sex when 'F' then 'Damas' when 'M' then 'Varones' else 'Otro' end)
      || ' · ' || public.result_age_group(p_age_group) end;
$$;
revoke all on function public.result_age_group(text), public.result_category_key(text,text), public.result_category_label(text,text) from public;
grant execute on function public.result_age_group(text), public.result_category_key(text,text), public.result_category_label(text,text) to anon, authenticated, service_role;

-- Two window passes; do not self-join ranked CTEs. A cold query with a newly
-- imported large roster must not depend on stale table cardinality estimates.
create or replace function public.calculate_event_participant_places(p_event_id uuid)
returns table (participant_id uuid, overall_place bigint, category_place bigint)
language sql stable security invoker set search_path = '' as $$
  with base as (
    select p.id as participant_id,p.sex,public.result_distance_key(p.distance) as distance_key,
      public.result_category_key(p.sex,p.age_bracket) as category_key,
      (d.award_policy_configured and d.exclude_general_top3_from_categories) as exclude_general,
      extract(epoch from (f.captured_at-s.captured_at)) as elapsed_seconds
    from public.event_participants p
    join public.timing_entries s on s.event_id=p.event_id and s.participant_id=p.id and s.stage='start'
    join public.timing_entries f on f.event_id=p.event_id and f.participant_id=p.id and f.stage='finish'
    left join public.event_distances d on d.event_id=p.event_id and d.distance=p.distance
    where p.event_id=p_event_id and p.dnf_at is null
  ), overall as (
    select b.*,rank() over (partition by b.distance_key,b.sex order by b.elapsed_seconds) as overall_place
    from base b where b.distance_key is not null
  ), eligible as (
    select o.*,o.category_key is not null and not (coalesce(o.exclude_general,false) and o.overall_place<=3) as category_eligible
    from overall o
  )
  select participant_id,overall_place,
    case when category_eligible then rank() over (partition by distance_key,category_key,category_eligible order by elapsed_seconds) end as category_place
  from eligible;
$$;
revoke all on function public.calculate_event_participant_places(uuid) from public,anon,authenticated,service_role;

create trigger event_distances_category_definition_dirty
after update of category_criteria,category_policy_version on public.event_distances
for each row execute function public.mark_event_podium_snapshot_dirty();
update public.event_podium_snapshots set dirty=true where dirty is distinct from true;

-- One-time, audited conversion of legacy labels. Runtime classification never
-- consults these labels. Ambiguous/non-literal ages remain explicitly missing.
create table public.category_criteria_conversion_audit (
  participant_id uuid primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  previous_age_bracket text,
  new_age_bracket text not null,
  source_category text not null,
  source_sex text not null,
  source_distance text not null,
  rule text not null,
  converted_at timestamptz not null default now()
);
alter table public.category_criteria_conversion_audit enable row level security;
revoke all on public.category_criteria_conversion_audit from public,anon,authenticated,service_role;
grant select on public.category_criteria_conversion_audit to authenticated;
create policy "Owners inspect category conversion" on public.category_criteria_conversion_audit
  for select to authenticated using (public.owns_event(event_id));

create temporary table criteria_conversion_context (placeholder integer) on commit drop;
create function pg_temp.legacy_age_group(p_category text,p_sex text,p_distance text) returns text
language plpgsql set search_path='' as $$
declare v_values text[]; v_special text[];
begin
  if p_category is null or nullif(btrim(p_distance),'') is null or p_sex is null or p_sex not in ('F','M','otro') then return null; end if;
  if (p_sex='F' and p_category ~* '\m(varones|varón|masculino)\M')
    or (p_sex='M' and p_category ~* '\m(damas|femenino|femenina)\M') then return null; end if;
  select array_agg(distinct public.result_age_group(m[1])) into v_values
  from regexp_matches(p_category,
    '(\d{1,3}\s*(?:a|al|hasta|[-–—])\s*\d{1,3}(?:\s*(?:años?|anos?))?|\d{1,3}\s*(?:y\s*)?(?:más|mas)\s*(?:años?|anos?))','gi') m;
  if cardinality(v_values)=1 and v_values[1] is not null then return v_values[1]; end if;
  if cardinality(v_values)>0 then return null; end if;
  if p_category ~* '(categor[ií]a\s+especial|cat\.?\s*(extra|especial))' then
    -- Reuse an explicit local value for this distance/sex; never invent limits.
    select array_agg(distinct public.result_age_group(p.age_bracket)) into v_special
    from public.event_participants p where p.distance=p_distance and p.sex=p_sex
      and p.age_bracket ~* '^(categor[ií]a\s+especial|cat\.?\s*(extra|especial))$';
    if cardinality(v_special)=1 then return v_special[1]; end if;
  end if;
  return null;
end;
$$;

insert into public.category_criteria_conversion_audit
  (participant_id,event_id,previous_age_bracket,new_age_bracket,source_category,source_sex,source_distance,rule)
select p.id,p.event_id,p.age_bracket,v.bracket,p.category,p.sex,p.distance,'unambiguous_legacy_age_literal_v1'
from public.event_participants p
cross join lateral (select pg_temp.legacy_age_group(p.category,p.sex,p.distance) as bracket) v
where nullif(btrim(p.age_bracket),'') is null and v.bracket is not null;
update public.event_participants p set age_bracket=a.new_age_bracket
from public.category_criteria_conversion_audit a where a.participant_id=p.id;

-- Scope ranking to each selected event before evaluating participant labels.
-- Filtering a small event must never recalculate another event's 5000 runners.
create or replace view public.event_results with (security_invoker=true) as
select e.id as event_id,b.* from public.events e cross join lateral (
  with ranked as materialized (select * from public.event_participant_places(e.id))
  select p.id as participant_id,p.bib,p.chip,p.first_name,p.last_name,p.sex,
    public.result_category_label(p.sex,p.age_bracket) as category,p.team,p.public_token,
    s.captured_at as start_at,s.origin as start_origin,s.antenna as start_antenna,s.rssi as start_rssi,
    f.captured_at as finish_at,f.origin as finish_origin,f.antenna as finish_antenna,f.rssi as finish_rssi,
    public.participant_result_status(p.chip,s.captured_at,f.captured_at,p.dnf_at) as result_status,
    case when s.captured_at is not null and f.captured_at is not null then extract(epoch from (f.captured_at-s.captured_at)) end as elapsed_seconds,
    r.overall_place,r.category_place,p.distance,p.rut,public.result_age_group(p.age_bracket) as age_bracket,
    public.result_category_key(p.sex,p.age_bracket) as category_key
  from public.event_participants p
  left join public.timing_entries s on s.event_id=p.event_id and s.participant_id=p.id and s.stage='start'
  left join public.timing_entries f on f.event_id=p.event_id and f.participant_id=p.id and f.stage='finish'
  left join ranked r on r.participant_id=p.id
  where p.event_id=e.id
) b;
grant select on public.event_results to authenticated;

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
  distance text,
  sex text,
  category_key text,
  age_bracket text
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
      public.result_category_label(p.sex,p.age_bracket) as category,
      public.result_category_key(p.sex,p.age_bracket) as category_key,
      public.result_age_group(p.age_bracket) as age_bracket,
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
  ranked as materialized (
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
    case when b.result_status='DNF' then null else b.elapsed_seconds end,
    place.overall_place,
    place.category_place,
    b.distance,
    b.sex,
    case when b.qr_show_category then b.category_key else null end,
    case when b.qr_show_category then b.age_bracket else null end
  from base b
  left join ranked place on place.participant_id = b.participant_id
  order by public.result_distance_key(b.distance) nulls last,
    case b.sex when 'F' then 1 when 'M' then 2 when 'otro' then 3 when 'no_informado' then 4 else 5 end,
    place.overall_place nulls last, b.bib nulls last, b.first_name nulls last;
$$;
revoke all on function public.get_public_event_standing(text) from public;
grant execute on function public.get_public_event_standing(text) to anon, authenticated;

create or replace function public.apply_event_transfer(
  p_package jsonb,
  p_mode text,
  p_final boolean,
  p_target_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_event_id uuid;
  v_event_id uuid;
  v_transfer_id uuid;
  v_operation_id uuid;
  v_base_hash text;
  v_payload_hash text;
  v_source_revision text;
  v_revision bigint;
  v_event public.events%rowtype;
  v_exists boolean;
  v_duplicate public.event_transfer_receipts%rowtype;
  v_participant jsonb;
  v_distance jsonb;
  v_mark jsonb;
  v_operation jsonb;
  v_history jsonb;
  v_receipt jsonb;
  v_action text;
  v_previous boolean;
  v_now timestamptz := now();
  v_counts jsonb;
  v_mismatch_count bigint;
  v_participant_count bigint;
  v_slug text;
  v_policy_version text;
  v_state text;
  v_participant_set jsonb;
  v_distance_keys text[];
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_mode not in ('preview', 'commit') then raise exception 'Transfer mode is invalid' using errcode = '22023'; end if;
  if p_package->>'format' <> 'yr-event-transfer' or (p_package->>'version')::integer <> 1
     or p_package->>'kind' <> 'publication' then
    raise exception 'Unsupported event transfer package' using errcode = '22023';
  end if;
  if jsonb_typeof(p_package->'participants') <> 'array'
     or jsonb_array_length(p_package->'participants') not between 1 and 5000
     or jsonb_typeof(p_package->'distances') <> 'array'
     or jsonb_array_length(p_package->'distances') < 1
     or jsonb_typeof(p_package->'marks') <> 'array'
     or jsonb_typeof(p_package->'operations') <> 'array'
     or jsonb_typeof(p_package->'receipts') <> 'array'
     or jsonb_typeof(p_package->'expected_results') <> 'array' then
    raise exception 'Transfer package arrays are missing or outside supported limits' using errcode = '22023';
  end if;
  if p_package->'policy'->>'preset_id' <> 'category_criteria_v1' or p_package->'policy'->>'revision' <> '1' then
    raise exception 'Unsupported policy version' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_package->'distances') d where d->'category_criteria' is distinct from '["sex","age_bracket"]'::jsonb or d->>'category_policy_version' is distinct from 'category_criteria_v1') then
    raise exception 'Unsupported category criteria' using errcode = '22023';
  end if;

  v_source_event_id := (p_package->'event'->>'id')::uuid;
  v_event_id := coalesce(p_target_event_id, v_source_event_id);
  if v_event_id <> v_source_event_id then
    raise exception 'Event ID mapping is not supported without an explicit participant reconciliation' using errcode = '22023';
  end if;
  v_transfer_id := (p_package->'manifest'->>'transfer_id')::uuid;
  v_revision := (p_package->'manifest'->>'revision')::bigint;
  v_source_revision := p_package->'manifest'->>'source_revision';
  v_payload_hash := lower(p_package->>'sha256');
  v_operation_id := nullif(p_package->'manifest'->>'operation_id', '')::uuid;
  v_base_hash := nullif(p_package->'manifest'->>'base_package_hash', '');
  v_policy_version := (p_package->'policy'->>'preset_id') || '@' || (p_package->'policy'->>'revision');
  if v_source_event_id is null or v_event_id is null or v_transfer_id is null or v_revision < 1
     or v_source_revision is null or char_length(v_source_revision) > 255
     or v_payload_hash is null or v_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Transfer manifest is invalid' using errcode = '22023';
  end if;
  if (p_target_event_id is null) <> (v_operation_id is null) then
    raise exception 'Choose a linked event for a prepared package or create a new destination for an autonomous package' using errcode = '22023';
  end if;
  if nullif(btrim(p_package->'event'->>'name'), '') is null
     or nullif(p_package->'event'->>'timezone', '') is null
     or nullif(p_package->'event'->>'status', '') is null then
    raise exception 'Transfer event definition is incomplete' using errcode = '22023';
  end if;
  if nullif(p_package->'event'->>'event_date', '') is null then
    raise exception 'Transfer event date is required' using errcode = '22023';
  end if;
  perform (p_package->'event'->>'event_date')::date;
  if p_final and (p_package->'event'->>'status') <> 'closed' then
    raise exception 'A final publication requires a locally closed event' using errcode = '22023';
  end if;
  if jsonb_array_length(p_package->'expected_results') <> jsonb_array_length(p_package->'participants') then
    raise exception 'Result snapshot does not include every participant' using errcode = '22023';
  end if;

  select * into v_event from public.events e where e.id = v_event_id for update;
  v_exists := found;
  if v_exists then
    if v_event.owner_id <> auth.uid() then raise exception 'Event not found or access denied' using errcode = '42501'; end if;
    select * into v_duplicate from public.event_transfer_receipts r where r.transfer_id = v_transfer_id;
    if found then
      if v_duplicate.event_id <> v_event_id or v_duplicate.payload_hash <> v_payload_hash then
        raise exception 'Transfer ID was already used with another event or content hash' using errcode = '23505';
      end if;
      v_receipt := jsonb_build_object(
        'format', 'yr-publication-receipt', 'version', 1, 'event_id', v_event_id, 'event_slug', v_event.slug,
        'transfer_id', v_duplicate.transfer_id, 'sha256', v_duplicate.payload_hash,
        'local_revision', v_duplicate.local_revision, 'source_revision', v_duplicate.source_revision,
        'revision', v_duplicate.local_revision,
        'policy_version', v_duplicate.policy_version, 'publication_state', v_duplicate.publication_state,
        'received', true, 'verified', true, 'published', v_duplicate.publication_state = 'final',
        'received_at', v_duplicate.received_at, 'verified_at', v_duplicate.verified_at, 'published_at', v_duplicate.published_at);
      return jsonb_build_object('duplicate', true, 'event_id', v_event_id, 'event_slug', v_event.slug,
        'revision', v_duplicate.local_revision, 'transfer_id', v_duplicate.transfer_id,
        'sha256', v_duplicate.payload_hash, 'publication_state', v_duplicate.publication_state,
        'received', true, 'verified', true, 'published', v_duplicate.publication_state = 'final',
        'receipt', v_receipt) || v_receipt;
    end if;
    if v_operation_id is not null then
      if v_event.local_operation_id <> v_operation_id
         or v_event.local_operation_status not in ('prepared', 'active') then
        raise exception 'The linked local operation is not active for this event' using errcode = '40001';
      end if;
      if v_event.local_operation_base_hash is null or v_event.local_operation_base_hash <> v_base_hash then
        raise exception 'The remote preparation changed or does not match this package; review and reconcile before publishing' using errcode = '40001';
      end if;
    else
      if v_event.local_operation_id is not null
         or coalesce(v_event.local_publication_state, '') not in ('provisional', 'final') then
        raise exception 'The remote event is not an autonomous publication destination' using errcode = '40001';
      end if;
    end if;
    if v_event.local_published_revision + 1 <> v_revision then
      raise exception 'A newer or missing local revision must be reconciled first' using errcode = '40001';
    end if;
  else
    if p_target_event_id is not null or v_operation_id is not null then
      raise exception 'The linked remote event no longer exists' using errcode = '40001';
    end if;
    -- Autonomous packages are complete snapshots. Their first upload may skip local
    -- revisions that were generated but never published; linked packages remain sequential.
  end if;
  select array_agg(upper(btrim(value->>'distance'))) filter (where nullif(btrim(value->>'distance'), '') is not null)
  into v_distance_keys
  from jsonb_array_elements(p_package->'distances');

  for v_participant in select value from jsonb_array_elements(p_package->'participants') loop
    if nullif(v_participant->>'id', '') is null or nullif(btrim(v_participant->>'first_name'), '') is null
       or nullif(btrim(v_participant->>'distance'), '') is null then
      raise exception 'A participant is missing identity, name, or distance' using errcode = '22023';
    end if;
    perform (v_participant->>'id')::uuid;
    if v_participant->>'sex' is not null and v_participant->>'sex' not in ('F', 'M', 'otro', 'no_informado') then
      raise exception 'Participant sex value is not supported' using errcode = '22023';
    end if;
    if nullif(v_participant->>'age', '') is not null then
      if (v_participant->>'age') !~ '^[0-9]{1,3}$' then
        raise exception 'Participant age must be an integer' using errcode = '22023';
      end if;
      if (v_participant->>'age')::integer not between 0 and 130 then
        raise exception 'Participant age is outside the supported range' using errcode = '22023';
      end if;
    end if;
    if not coalesce(upper(btrim(v_participant->>'distance')) = any(v_distance_keys), false) then
      raise exception 'A participant refers to a distance absent from the package' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct (value->>'id')::uuid) from jsonb_array_elements(p_package->'participants')) <> jsonb_array_length(p_package->'participants') then
    raise exception 'Participant IDs are duplicated' using errcode = '22023';
  end if;
  if exists (
    select nullif(btrim(value->>'bib'), '') from jsonb_array_elements(p_package->'participants')
    where nullif(btrim(value->>'bib'), '') is not null
    group by nullif(btrim(value->>'bib'), '') having count(*) > 1
  ) or exists (
    select upper(regexp_replace(btrim(value->>'chip'), '\s', '', 'g')) from jsonb_array_elements(p_package->'participants')
    where nullif(btrim(value->>'chip'), '') is not null
    group by upper(regexp_replace(btrim(value->>'chip'), '\s', '', 'g')) having count(*) > 1
  ) or exists (
    select value->>'public_token' from jsonb_array_elements(p_package->'participants')
    where nullif(value->>'public_token', '') is not null
    group by value->>'public_token' having count(*) > 1
  ) then
    raise exception 'Participant bibs, chips, or public tokens are duplicated' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_package->'participants') incoming
    join public.event_participants existing on existing.id = (incoming->>'id')::uuid
    where existing.event_id <> v_event_id
  ) then
    raise exception 'A participant identity already belongs to another event; no cross-event merge was applied' using errcode = '23505';
  end if;
  if (select count(distinct upper(btrim(value->>'distance'))) from jsonb_array_elements(p_package->'distances')) <> jsonb_array_length(p_package->'distances') then
    raise exception 'Distance keys are duplicated' using errcode = '22023';
  end if;
  select jsonb_object_agg(value->>'id', true) into v_participant_set
  from jsonb_array_elements(p_package->'participants');

  for v_mark in select value from jsonb_array_elements(p_package->'marks') loop
    if v_mark->>'stage' not in ('start', 'finish') or nullif(v_mark->>'captured_at', '') is null
       or not coalesce(v_participant_set ? (v_mark->>'participant_id'), false) then
      raise exception 'A timing mark is incomplete or refers to an unknown participant' using errcode = '22023';
    end if;
    perform (v_mark->>'captured_at')::timestamptz;
  end loop;
  if exists (
    select value->>'participant_id', value->>'stage'
    from jsonb_array_elements(p_package->'marks')
    group by value->>'participant_id', value->>'stage' having count(*) > 1
  ) then
    raise exception 'Duplicate current timing mark for a participant and stage' using errcode = '22023';
  end if;
  for v_operation in select value from jsonb_array_elements(p_package->'operations') loop
    if nullif(v_operation->>'operation_id', '') is null
       or v_operation->>'stage' not in ('start', 'finish')
       or v_operation->>'kind' not in ('rfid_accepted', 'manual_set', 'manual_voided')
       or not coalesce(v_participant_set ? (v_operation->>'participant_id'), false) then
      raise exception 'A timing operation is incomplete or refers to an unknown participant' using errcode = '22023';
    end if;
    if v_operation->>'kind' <> 'manual_voided' then
      perform (v_operation->>'captured_at')::timestamptz;
    end if;
  end loop;
  if (select count(distinct value->>'operation_id') from jsonb_array_elements(p_package->'operations')) <> jsonb_array_length(p_package->'operations') then
    raise exception 'Timing operation IDs are duplicated' using errcode = '22023';
  end if;
  for v_receipt in select value from jsonb_array_elements(p_package->'receipts') loop
    if nullif(v_receipt->>'device_id', '') is null or nullif(v_receipt->>'reading_id', '') is null
       or nullif(v_receipt->>'status', '') is null or nullif(v_receipt->>'received_at', '') is null then
      raise exception 'A sanitized local ingest receipt is incomplete' using errcode = '22023';
    end if;
    perform (v_receipt->>'device_id')::uuid;
    perform (v_receipt->>'reading_id')::uuid;
    perform (v_receipt->>'received_at')::timestamptz;
  end loop;
  if (select count(distinct value->>'participant_id') from jsonb_array_elements(p_package->'expected_results')) <> jsonb_array_length(p_package->'participants')
     or exists (
       select 1 from jsonb_array_elements(p_package->'expected_results') expected
       where not coalesce(v_participant_set ? (expected->>'participant_id'), false)
     ) then
    raise exception 'Result snapshot participant identities do not match the roster' using errcode = '22023';
  end if;
  v_counts := jsonb_build_object(
    'participants', jsonb_array_length(p_package->'participants'),
    'distances', jsonb_array_length(p_package->'distances'),
    'marks', jsonb_array_length(p_package->'marks'),
    'operations', jsonb_array_length(p_package->'operations'),
    'receipts', jsonb_array_length(p_package->'receipts'));
  if p_mode = 'preview' then
    return jsonb_build_object('event_id', v_event_id, 'event_name', coalesce(v_event.name, p_package->'event'->>'name'),
      'local_revision', v_revision, 'remote_revision', case when v_exists then v_event.local_published_revision else 0 end,
      'policy_version', v_policy_version, 'counts', v_counts, 'duplicate', false,
      'destination', case when v_exists then 'linked' else 'new' end,
      'publication_state', case when p_final then 'final' else 'provisional' end);
  end if;

  perform set_config('app.d07_transfer_event_id', v_event_id::text, true);
  if not v_exists then
    v_event.name := btrim(p_package->'event'->>'name');
    v_event.organizer := nullif(btrim(p_package->'event'->>'organizer'),'');
    v_event.timezone := p_package->'event'->>'timezone';
    v_event.start_at := nullif(p_package->'event'->>'start_at','')::timestamptz;
    if char_length(v_event.name) < 2 then raise exception 'Event name is required' using errcode = '22023'; end if;
    v_slug := trim(both '-' from regexp_replace(lower(v_event.name), '[^a-z0-9]+', '-', 'g'));
    v_slug := left(coalesce(nullif(v_slug, ''), 'evento'), 48) || '-' || left(replace(v_transfer_id::text, '-', ''), 8);
    insert into public.events(id, owner_id, name, slug, organizer, timezone, start_at, status,
      qr_show_name, qr_show_bib, qr_show_category, event_date)
    values (v_event_id, auth.uid(), v_event.name, v_slug, v_event.organizer, v_event.timezone, v_event.start_at, 'draft',
      coalesce((p_package->'event'->>'qr_show_name')::boolean, true),
      coalesce((p_package->'event'->>'qr_show_bib')::boolean, true),
      coalesce((p_package->'event'->>'qr_show_category')::boolean, true),
      nullif(p_package->'event'->>'event_date', '')::date);
  else
    v_slug := v_event.slug;
  end if;

  for v_distance in select value from jsonb_array_elements(p_package->'distances') loop
    insert into public.event_distances(event_id, distance, official_start_at, started_at,
      exclude_general_top3_from_categories, award_policy_configured)
    values (v_event_id, upper(btrim(v_distance->>'distance')),
      nullif(v_distance->>'official_start_at', '')::timestamptz,
      nullif(v_distance->>'started_at', '')::timestamptz,
      coalesce(nullif(v_distance->>'exclude_general_top3_from_categories', '')::boolean,
        public.result_distance_key(v_distance->>'distance') in ('10KM', '21KM')),
      coalesce(nullif(v_distance->>'award_policy_configured', '')::boolean, true))
    on conflict (event_id, distance) do update set
      official_start_at = excluded.official_start_at,
      started_at = excluded.started_at,
      exclude_general_top3_from_categories = excluded.exclude_general_top3_from_categories,
      award_policy_configured = excluded.award_policy_configured;
  end loop;

  for v_participant in select value from jsonb_array_elements(p_package->'participants') loop
    insert into public.event_participants(
      id, event_id, bib, chip, first_name, last_name, sex, category, team, distance, age, age_bracket, dnf_at, public_token
    ) values (
      (v_participant->>'id')::uuid, v_event_id, nullif(btrim(v_participant->>'bib'), ''),
      nullif(upper(regexp_replace(btrim(coalesce(v_participant->>'chip', '')), '\s', '', 'g')), ''),
      btrim(v_participant->>'first_name'), nullif(btrim(v_participant->>'last_name'), ''),
      nullif(v_participant->>'sex', ''), nullif(btrim(v_participant->>'category'), ''), nullif(btrim(v_participant->>'team'), ''),
      upper(btrim(v_participant->>'distance')), nullif(v_participant->>'age', '')::integer,
      nullif(btrim(v_participant->>'age_bracket'), ''), nullif(v_participant->>'dnf_at', '')::timestamptz,
      coalesce(nullif(v_participant->>'public_token', ''), encode(extensions.gen_random_bytes(24), 'hex'))
    ) on conflict (id) do update set
      bib = excluded.bib,
      chip = excluded.chip,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      sex = excluded.sex,
      category = excluded.category,
      team = excluded.team,
      distance = excluded.distance,
      age = excluded.age,
      age_bracket = excluded.age_bracket,
      dnf_at = excluded.dnf_at;
  end loop;

  delete from public.timing_entries where event_id = v_event_id;
  delete from public.timing_entry_audit where event_id = v_event_id and local_transfer_id is not null;

  for v_mark in select value from jsonb_array_elements(p_package->'marks') loop
    if not exists (select 1 from public.event_participants p where p.id = (v_mark->>'participant_id')::uuid and p.event_id = v_event_id)
       or v_mark->>'stage' not in ('start', 'finish') then
      raise exception 'A timing mark refers to an invalid participant or stage' using errcode = '22023';
    end if;
    insert into public.timing_entries(event_id, participant_id, stage, captured_at, origin, antenna, rssi)
    values (v_event_id, (v_mark->>'participant_id')::uuid, v_mark->>'stage', (v_mark->>'captured_at')::timestamptz,
      case when v_mark->>'kind' = 'manual_set' then 'manual' else 'rfid' end,
      nullif(v_mark->>'antenna', '')::smallint, nullif(v_mark->>'rssi', '')::smallint);
  end loop;

  for v_operation in select value from jsonb_array_elements(p_package->'operations') order by (value->>'operation_order')::bigint loop
    if not exists (select 1 from public.event_participants p where p.id = (v_operation->>'participant_id')::uuid and p.event_id = v_event_id)
       or v_operation->>'stage' not in ('start', 'finish')
       or v_operation->>'kind' not in ('rfid_accepted', 'manual_set', 'manual_voided') then
      raise exception 'A timing operation refers to an invalid participant, stage, or kind' using errcode = '22023';
    end if;
    v_action := case v_operation->>'kind'
      when 'rfid_accepted' then 'rfid_accepted'
      when 'manual_voided' then 'manual_voided'
      else 'manual_created' end;
    if v_operation->>'kind' = 'manual_set' then
      select exists (
        select 1 from public.timing_entry_audit a where a.event_id = v_event_id
          and a.participant_id = (v_operation->>'participant_id')::uuid and a.stage = v_operation->>'stage'
          and a.local_operation_id is not null
      ) into v_previous;
      if v_previous then v_action := 'manual_corrected'; end if;
    end if;
    insert into public.timing_entry_audit(event_id, participant_id, stage, action, actor_type, reason,
      after_entry, created_at, local_transfer_id, local_operation_id)
    select v_event_id, (v_operation->>'participant_id')::uuid, v_operation->>'stage', v_action,
      case when v_operation->>'kind' = 'rfid_accepted' then 'device' else 'operator' end,
      nullif(v_operation->>'reason', ''),
      case when v_operation->>'kind' = 'manual_voided' then null else jsonb_build_object(
        'captured_at', v_operation->>'captured_at', 'origin', case when v_operation->>'kind' = 'manual_set' then 'manual' else 'rfid' end,
        'antenna', v_operation->'antenna', 'rssi', v_operation->'rssi', 'source_reading_id', v_operation->'source_reading_id') end,
      coalesce(nullif(v_operation->>'created_at', '')::timestamptz, v_now), v_transfer_id, v_operation->>'operation_id'
    where not exists (select 1 from public.timing_entry_audit a where a.event_id = v_event_id and a.local_operation_id = v_operation->>'operation_id');
  end loop;

  for v_history in select value from jsonb_array_elements(coalesce(p_package->'history', '[]'::jsonb)) loop
    if nullif(v_history->>'action', '') is null or nullif(v_history->>'created_at', '') is null then
      raise exception 'Event history operation is incomplete' using errcode = '22023';
    end if;
    insert into public.local_operation_history(event_id, operation_id, transfer_id, action, entity_id, occurred_at, details)
    values (v_event_id, v_history->>'action' || ':' || coalesce(v_history->>'entity_id', '') || ':' ||
      coalesce(v_history->>'created_at', ''), v_transfer_id, v_history->>'action', v_history->>'entity_id',
      (v_history->>'created_at')::timestamptz, coalesce(v_history->'details', '{}'::jsonb))
    on conflict (event_id, operation_id) do nothing;
  end loop;

  for v_receipt in select value from jsonb_array_elements(p_package->'receipts') loop
    if nullif(v_receipt->>'device_id', '') is null or nullif(v_receipt->>'reading_id', '') is null
       or nullif(v_receipt->>'status', '') is null or nullif(v_receipt->>'received_at', '') is null then
      raise exception 'A sanitized local ingest receipt is incomplete' using errcode = '22023';
    end if;
    insert into public.local_operation_history(event_id, operation_id, transfer_id, action, entity_id, occurred_at, details)
    values (v_event_id, 'receipt:' || (v_receipt->>'device_id') || ':' || (v_receipt->>'reading_id'), v_transfer_id,
      'local_ingest_receipt', v_receipt->>'reading_id', (v_receipt->>'received_at')::timestamptz,
      jsonb_build_object('device_id', v_receipt->>'device_id', 'status', v_receipt->>'status',
        'reason', v_receipt->>'reason', 'stage', v_receipt->>'stage', 'captured_at', v_receipt->>'captured_at'))
    on conflict (event_id, operation_id) do nothing;
  end loop;

  select count(*) into v_participant_count from public.event_participants p where p.event_id = v_event_id;
  if v_participant_count <> jsonb_array_length(p_package->'participants') then
    raise exception 'Participant count differs from the local review' using errcode = '40001';
  end if;
  select count(*) into v_mismatch_count
  from jsonb_to_recordset(p_package->'expected_results') as expected(
    participant_id uuid, status text, start_at timestamptz, finish_at timestamptz,
    overall_place bigint, category_place bigint
  )
  left join public.event_results actual on actual.event_id = v_event_id and actual.participant_id = expected.participant_id
  where actual.participant_id is null
    or actual.result_status is distinct from expected.status
    or actual.start_at is distinct from expected.start_at
    or actual.finish_at is distinct from expected.finish_at
    or actual.overall_place is distinct from expected.overall_place
    or actual.category_place is distinct from expected.category_place;
  if v_mismatch_count <> 0 then
    raise exception 'Remote recalculation differs from the local snapshot; the previous public revision was preserved' using errcode = '40001';
  end if;

  v_state := case when p_final then 'final' else 'provisional' end;
  update public.events set
    local_published_revision = v_revision,
    local_last_transfer_id = v_transfer_id,
    local_last_transfer_hash = v_payload_hash,
    local_publication_state = v_state,
    status = case when p_final then 'published' else status end,
    updated_at = v_now
  where id = v_event_id;
  insert into public.event_transfer_receipts(
    transfer_id, event_id, local_revision, payload_hash, source_revision, policy_version,
    publication_state, received_by, received_at, verified_at, published_at
  ) values (
    v_transfer_id, v_event_id, v_revision, v_payload_hash, v_source_revision, v_policy_version,
    v_state, auth.uid(), v_now, v_now, v_now
  );
  v_receipt := jsonb_build_object(
    'format', 'yr-publication-receipt', 'version', 1, 'event_id', v_event_id, 'event_slug', v_slug,
    'transfer_id', v_transfer_id, 'sha256', v_payload_hash, 'local_revision', v_revision,
    'source_revision', v_source_revision, 'revision', v_revision, 'policy_version', v_policy_version, 'publication_state', v_state,
    'received', true, 'verified', true, 'published', p_final,
    'received_at', v_now, 'verified_at', v_now, 'published_at', v_now
  );
  return jsonb_build_object('event_id', v_event_id, 'event_slug', v_slug, 'duplicate', false,
    'counts', v_counts, 'receipt', v_receipt) || v_receipt;
end;
$$;

revoke all on function public.apply_event_transfer(jsonb, text, boolean, uuid) from public, anon;
grant execute on function public.apply_event_transfer(jsonb, text, boolean, uuid) to authenticated;

-- Category text is provenance only, including on insert/update.
drop trigger event_participants_gender_category on public.event_participants;
create or replace function public.ensure_event_distance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group_changes boolean := tg_op = 'INSERT';
  v_started_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    v_group_changes := old.event_id is distinct from new.event_id or old.distance is distinct from new.distance;
  end if;
  if new.distance is not null then
    new.distance := upper(btrim(new.distance));
    if v_group_changes then
      select d.started_at into v_started_at
      from public.event_distances d
      where d.event_id = new.event_id and d.distance = new.distance
      for update;
      if v_started_at is not null then
        raise exception 'Cannot add or move a participant into a distance that has already started' using errcode = '23514';
      end if;
    end if;
    insert into public.event_distances(event_id, distance)
    values (new.event_id, new.distance)
    on conflict (event_id, distance) do nothing;
  end if;
  return new;
end;
$$;

notify pgrst,'reload schema';

commit;
