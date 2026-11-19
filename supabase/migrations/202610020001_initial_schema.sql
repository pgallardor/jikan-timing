create extension if not exists pgcrypto with schema extensions;

create table public.events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  organizer text,
  timezone text not null default 'America/Santiago',
  start_at timestamptz,
  status text not null default 'draft'
    check (status in ('draft', 'open', 'closed', 'published')),
  minimum_rssi smallint not null default -70 check (minimum_rssi between -120 and 0),
  qr_show_name boolean not null default true,
  qr_show_bib boolean not null default true,
  qr_show_category boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.event_participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  bib text,
  chip text,
  first_name text not null check (char_length(first_name) between 1 and 100),
  last_name text,
  sex text check (sex in ('F', 'M', 'otro', 'no_informado')),
  category text,
  team text,
  public_token text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  created_at timestamptz not null default now(),
  unique (event_id, id),
  constraint participant_bib_not_blank check (bib is null or char_length(btrim(bib)) > 0),
  constraint participant_chip_normalized check (chip is null or chip = upper(regexp_replace(chip, '\s', '', 'g')))
);
create unique index event_participants_bib_unique
  on public.event_participants(event_id, bib) where bib is not null;
create unique index event_participants_chip_unique
  on public.event_participants(event_id, chip) where chip is not null;
create index event_participants_name_idx
  on public.event_participants(event_id, last_name, first_name);

create table public.reader_devices (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 100),
  credential_hash text not null,
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, name)
);

create table public.timing_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  participant_id uuid not null references public.event_participants(id) on delete cascade,
  stage text not null check (stage in ('start', 'finish')),
  captured_at timestamptz not null,
  origin text not null check (origin in ('rfid', 'manual')),
  antenna smallint,
  rssi smallint,
  sequence_no bigint,
  device_id uuid references public.reader_devices(id) on delete set null,
  operator_id uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (event_id, participant_id, stage),
  constraint timing_entry_event_participant_match foreign key (event_id, participant_id)
    references public.event_participants(event_id, id) on delete cascade
);
create index timing_entries_event_stage_idx on public.timing_entries(event_id, stage, captured_at);

create table public.timing_entry_audit (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  participant_id uuid not null references public.event_participants(id) on delete cascade,
  stage text not null check (stage in ('start', 'finish')),
  action text not null check (action in ('manual_created', 'manual_corrected', 'manual_voided', 'rfid_accepted', 'rfid_ignored')),
  actor_type text not null check (actor_type in ('operator', 'device')),
  actor_id uuid,
  reason text,
  before_entry jsonb,
  after_entry jsonb,
  created_at timestamptz not null default now(),
  constraint timing_audit_event_participant_match foreign key (event_id, participant_id)
    references public.event_participants(event_id, id) on delete cascade
);
create index timing_entry_audit_event_created_idx on public.timing_entry_audit(event_id, created_at desc);

create table public.ingest_receipts (
  id bigint generated always as identity primary key,
  device_id uuid not null references public.reader_devices(id) on delete cascade,
  reading_id uuid not null,
  status text not null,
  response jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  unique (device_id, reading_id)
);

create or replace function public.owns_event(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.events e
    where e.id = p_event_id and e.owner_id = (select auth.uid())
  );
$$;
revoke all on function public.owns_event(uuid) from public, anon;
grant execute on function public.owns_event(uuid) to authenticated;

alter table public.events enable row level security;
alter table public.event_participants enable row level security;
alter table public.reader_devices enable row level security;
alter table public.timing_entries enable row level security;
alter table public.timing_entry_audit enable row level security;
alter table public.ingest_receipts enable row level security;

create policy "Owners manage their events" on public.events
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "Owners manage event participants" on public.event_participants
  for all to authenticated
  using (public.owns_event(event_id))
  with check (public.owns_event(event_id));
create policy "Owners manage event devices" on public.reader_devices
  for all to authenticated
  using (public.owns_event(event_id))
  with check (public.owns_event(event_id));
create policy "Owners read timing entries" on public.timing_entries
  for select to authenticated using (public.owns_event(event_id));
create policy "Owners read timing audit" on public.timing_entry_audit
  for select to authenticated using (public.owns_event(event_id));

revoke all on public.events, public.event_participants, public.reader_devices,
  public.timing_entries, public.timing_entry_audit, public.ingest_receipts from anon, authenticated;
grant select, insert, update, delete on public.events, public.event_participants to authenticated;
grant select (id, event_id, name, is_active, last_seen_at, created_at),
  insert (event_id, name, credential_hash),
  update (name, is_active),
  delete on public.reader_devices to authenticated;
grant select on public.timing_entries, public.timing_entry_audit to authenticated;

create or replace function public.record_manual_entry(
  p_event_id uuid,
  p_participant_id uuid,
  p_stage text,
  p_captured_at timestamptz,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_id uuid;
begin
  if auth.uid() is null or not public.owns_event(p_event_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_stage not in ('start', 'finish') then
    raise exception 'Invalid stage' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'An audit reason is required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.event_participants p
    where p.id = p_participant_id and p.event_id = p_event_id
  ) then
    raise exception 'Participant does not belong to this event' using errcode = '23503';
  end if;

  select to_jsonb(t) into v_before
  from public.timing_entries t
  where t.event_id = p_event_id and t.participant_id = p_participant_id and t.stage = p_stage
  for update;

  insert into public.timing_entries(event_id, participant_id, stage, captured_at, origin, operator_id)
  values (p_event_id, p_participant_id, p_stage, p_captured_at, 'manual', auth.uid())
  on conflict (event_id, participant_id, stage) do update
    set captured_at = excluded.captured_at,
        origin = 'manual',
        antenna = null,
        rssi = null,
        device_id = null,
        operator_id = auth.uid(),
        updated_at = now()
  returning id, to_jsonb(timing_entries) into v_id, v_after;

  insert into public.timing_entry_audit(
    event_id, participant_id, stage, action, actor_type, actor_id, reason, before_entry, after_entry
  ) values (
    p_event_id, p_participant_id, p_stage,
    case when v_before is null then 'manual_created' else 'manual_corrected' end,
    'operator', auth.uid(), btrim(p_reason), v_before, v_after
  );
  return v_id;
end;
$$;
revoke all on function public.record_manual_entry(uuid, uuid, text, timestamptz, text) from public, anon;
grant execute on function public.record_manual_entry(uuid, uuid, text, timestamptz, text) to authenticated;

create or replace function public.void_timing_entry(
  p_event_id uuid,
  p_participant_id uuid,
  p_stage text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
begin
  if auth.uid() is null or not public.owns_event(p_event_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'An audit reason is required' using errcode = '22023';
  end if;
  delete from public.timing_entries
  where event_id = p_event_id and participant_id = p_participant_id and stage = p_stage
  returning to_jsonb(timing_entries) into v_before;
  if v_before is null then
    raise exception 'Timing entry does not exist' using errcode = 'P0002';
  end if;
  insert into public.timing_entry_audit(
    event_id, participant_id, stage, action, actor_type, actor_id, reason, before_entry
  ) values (
    p_event_id, p_participant_id, p_stage, 'manual_voided', 'operator', auth.uid(), btrim(p_reason), v_before
  );
end;
$$;
revoke all on function public.void_timing_entry(uuid, uuid, text, text) from public, anon;
grant execute on function public.void_timing_entry(uuid, uuid, text, text) to authenticated;

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
  insert into public.event_participants(event_id, bib, chip, first_name, last_name, sex, category, team)
  select p_event_id,
    nullif(btrim(x.bib), ''),
    nullif(upper(regexp_replace(btrim(x.chip), '\s', '', 'g')), ''),
    btrim(x.first_name),
    nullif(btrim(x.last_name), ''),
    case
      when x.sex in ('F', 'M', 'otro', 'no_informado') then x.sex
      else null
    end,
    nullif(btrim(x.category), ''),
    nullif(btrim(x.team), '')
  from jsonb_to_recordset(p_participants) as x(
    bib text, chip text, first_name text, last_name text, sex text, category text, team text
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.import_event_participants(uuid, jsonb) from public, anon;
grant execute on function public.import_event_participants(uuid, jsonb) to authenticated;

create or replace function public.ingest_rfid_reading(
  p_event_id uuid,
  p_device_id uuid,
  p_reading_id uuid,
  p_stage text,
  p_epc text,
  p_captured_at timestamptz,
  p_antenna smallint,
  p_rssi smallint,
  p_sequence_no bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_status text;
  v_minimum_rssi smallint;
  v_participant_id uuid;
  v_receipt public.ingest_receipts%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_updated_id uuid;
  v_status text;
  v_response jsonb;
begin
  if p_stage not in ('start', 'finish') or p_epc is null or char_length(p_epc) > 128 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if not exists (
    select 1 from public.reader_devices d
    where d.id = p_device_id and d.event_id = p_event_id and d.is_active
  ) then
    return jsonb_build_object('status', 'invalid_device');
  end if;

  insert into public.ingest_receipts(device_id, reading_id, status, response)
  values (p_device_id, p_reading_id, 'processing', '{}'::jsonb)
  on conflict (device_id, reading_id) do nothing;
  if not found then
    select * into v_receipt from public.ingest_receipts r
    where r.device_id = p_device_id and r.reading_id = p_reading_id;
    return jsonb_build_object('status', 'duplicate', 'original_status', v_receipt.status);
  end if;

  select e.status, e.minimum_rssi into v_event_status, v_minimum_rssi
  from public.events e where e.id = p_event_id;
  if v_event_status is distinct from 'open' then
    v_status := 'event_closed';
  elsif p_rssi < v_minimum_rssi then
    v_status := 'below_threshold';
  else
    select p.id into v_participant_id
    from public.event_participants p
    where p.event_id = p_event_id and p.chip = upper(regexp_replace(p_epc, '\s', '', 'g'));
    if v_participant_id is null then
      v_status := 'unknown_chip';
    else
      select to_jsonb(t) into v_before from public.timing_entries t
      where t.event_id = p_event_id and t.participant_id = v_participant_id and t.stage = p_stage
      for update;

      insert into public.timing_entries(event_id, participant_id, stage, captured_at, origin, antenna, rssi, sequence_no, device_id)
      values (p_event_id, v_participant_id, p_stage, p_captured_at, 'rfid', p_antenna, p_rssi, p_sequence_no, p_device_id)
      on conflict (event_id, participant_id, stage) do update
        set captured_at = excluded.captured_at,
            origin = 'rfid',
            antenna = excluded.antenna,
            rssi = excluded.rssi,
            sequence_no = excluded.sequence_no,
            device_id = excluded.device_id,
            operator_id = null,
            updated_at = now()
        where timing_entries.origin = 'rfid'
          and excluded.captured_at < timing_entries.captured_at
      returning id, to_jsonb(timing_entries.*) into v_updated_id, v_after;

      if v_updated_id is null then
        v_status := case when v_before ->> 'origin' = 'manual' then 'manual_override' else 'later_than_current' end;
      else
        v_status := 'accepted';
      end if;
      insert into public.timing_entry_audit(
        event_id, participant_id, stage, action, actor_type, actor_id, before_entry, after_entry
      ) values (
        p_event_id, v_participant_id, p_stage,
        case when v_updated_id is null then 'rfid_ignored' else 'rfid_accepted' end,
        'device', p_device_id, v_before, v_after
      );
    end if;
  end if;

  v_response := jsonb_build_object('status', v_status);
  update public.ingest_receipts set status = v_status, response = v_response
  where device_id = p_device_id and reading_id = p_reading_id;
  return v_response;
end;
$$;
revoke all on function public.ingest_rfid_reading(uuid, uuid, uuid, text, text, timestamptz, smallint, smallint, bigint) from public, anon, authenticated;
grant execute on function public.ingest_rfid_reading(uuid, uuid, uuid, text, text, timestamptz, smallint, smallint, bigint) to service_role;

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
    case when b.qr_show_name then
      concat_ws(' ', (select p.first_name from public.event_participants p where p.id = b.participant_id),
        case when (select p.last_name from public.event_participants p where p.id = b.participant_id) is not null
          then left((select p.last_name from public.event_participants p where p.id = b.participant_id), 1) || '.'
        end)
    else null end,
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
    case when b.qr_show_name then
      concat_ws(' ', b.first_name,
        case when b.last_name is not null then left(b.last_name, 1) || '.' end)
    else null end,
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
      then extract(epoch from (f.captured_at - s.captured_at)) end as elapsed_seconds
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
select b.*, r.overall_place, r.category_place
from base b left join ranked r on r.participant_id = b.participant_id;
grant select on public.event_results to authenticated;
