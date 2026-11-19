alter table public.events drop constraint if exists events_status_check;
alter table public.events add constraint events_status_check
  check (status in ('draft', 'open', 'closed', 'published', 'cancelled'));

alter table public.event_distances
  add column if not exists exclude_general_top3_from_categories boolean not null default false,
  add column if not exists award_policy_configured boolean not null default false;

-- Keep the generic write guard safe for tables that do not have reader-device fields.
create or replace function public.guard_local_operation_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_local_status text;
  v_override text;
begin
  if tg_table_name = 'events' then
    v_event_id := coalesce(new.id, old.id);
  else
    v_event_id := coalesce(new.event_id, old.event_id);
  end if;
  v_override := current_setting('app.d07_transfer_event_id', true);
  if v_override = v_event_id::text then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_table_name = 'reader_devices' and tg_op = 'UPDATE' then
    if (new.event_id, new.name, new.credential_hash, new.is_active) is not distinct from
       (old.event_id, old.name, old.credential_hash, old.is_active) then
      return new;
    end if;
  end if;
  select e.local_operation_status into v_local_status from public.events e where e.id = v_event_id;
  if v_local_status in ('prepared', 'active') then
    raise exception 'Event is controlled by a prepared local operation' using errcode = '55000', detail = 'local_operation_active';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.guard_local_operation_write() from public, anon, authenticated;

-- Preserve the ranking rule that was hard-coded by the previous releases.
update public.event_distances
set exclude_general_top3_from_categories = public.result_distance_key(distance) in ('10KM', '21KM'),
    award_policy_configured = true;

create or replace function public.event_participant_places(p_event_id uuid)
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
revoke all on function public.event_participant_places(uuid) from public, anon;
grant execute on function public.event_participant_places(uuid) to authenticated;

create or replace function public.get_public_available_events()
returns table (name text, slug text, status text, start_at timestamptz, timezone text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.name, e.slug, e.status, e.start_at, e.timezone
  from public.events e
  where e.status in ('open', 'published')
  order by case when e.status = 'open' then 0 else 1 end, e.start_at desc nulls last, e.created_at desc;
$$;
revoke all on function public.get_public_available_events() from public;
grant execute on function public.get_public_available_events() to anon, authenticated;


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
  if p_package->'policy'->>'preset_id' <> 'compat_actual_v1' or p_package->'policy'->>'revision' <> '1' then
    raise exception 'Unsupported policy version' using errcode = '22023';
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
    if v_operation_id is null or v_event.local_operation_id <> v_operation_id
       or v_event.local_operation_status not in ('prepared', 'active') then
      raise exception 'The linked local operation is not active for this event' using errcode = '40001';
    end if;
    if v_event.local_operation_base_hash is null or v_event.local_operation_base_hash <> v_base_hash then
      raise exception 'The remote preparation changed or does not match this package; review and reconcile before publishing' using errcode = '40001';
    end if;
    if v_event.local_published_revision + 1 <> v_revision then
      raise exception 'A newer or missing local revision must be reconciled first' using errcode = '40001';
    end if;
  else
    if p_target_event_id is not null or v_operation_id is not null then
      raise exception 'The linked remote event no longer exists' using errcode = '40001';
    end if;
    if v_revision <> 1 then raise exception 'The first autonomous publication must be revision one' using errcode = '40001'; end if;
    v_event.id := v_event_id;
    v_event.name := left(btrim(coalesce(p_package->'event'->>'name', '')), 120);
    v_event.timezone := coalesce(nullif(p_package->'event'->>'timezone', ''), 'America/Santiago');
    v_event.organizer := nullif(btrim(p_package->'event'->>'organizer'), '');
    v_event.start_at := nullif(p_package->'event'->>'start_at', '')::timestamptz;
  end if;

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
    if not exists (select 1 from jsonb_array_elements(p_package->'distances') x where upper(btrim(x->>'distance')) = upper(btrim(v_participant->>'distance'))) then
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
  for v_mark in select value from jsonb_array_elements(p_package->'marks') loop
    if v_mark->>'stage' not in ('start', 'finish') or nullif(v_mark->>'captured_at', '') is null
       or not exists (select 1 from jsonb_array_elements(p_package->'participants') p where p->>'id' = v_mark->>'participant_id') then
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
       or not exists (select 1 from jsonb_array_elements(p_package->'participants') p where p->>'id' = v_operation->>'participant_id') then
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
       where not exists (select 1 from jsonb_array_elements(p_package->'participants') p where p->>'id' = expected->>'participant_id')
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
