alter table public.ingest_receipts
  add column if not exists payload jsonb,
  add column if not exists payload_hash text,
  add column if not exists reprocessed_count integer not null default 0;

create table public.ingest_receipt_reprocess_audit (
  id bigint generated always as identity primary key,
  receipt_id bigint not null references public.ingest_receipts(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  device_id uuid not null references public.reader_devices(id) on delete cascade,
  reading_id uuid not null,
  operator_id uuid not null references auth.users(id),
  reason text not null check (char_length(reason) between 5 and 200),
  previous_status text not null,
  previous_response jsonb not null,
  result_status text not null,
  result_response jsonb not null,
  created_at timestamptz not null default now()
);
create index ingest_receipt_reprocess_event_created_idx
  on public.ingest_receipt_reprocess_audit(event_id, created_at desc);

alter table public.ingest_receipt_reprocess_audit enable row level security;
revoke all on public.ingest_receipt_reprocess_audit from anon, authenticated;

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
  v_event_name text;
  v_event_status text;
  v_minimum_rssi smallint;
  v_participant_id uuid;
  v_receipt public.ingest_receipts%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_updated_id uuid;
  v_epc text;
  v_payload jsonb;
  v_payload_hash text;
  v_status text;
  v_effect text;
  v_response jsonb;
begin
  v_epc := upper(regexp_replace(coalesce(p_epc, ''), '\s', '', 'g'));
  if p_stage not in ('start', 'finish') or v_epc = '' or char_length(v_epc) > 128 then
    return jsonb_build_object('status', 'invalid', 'reason', 'invalid_payload');
  end if;
  if not exists (
    select 1 from public.reader_devices d
    where d.id = p_device_id and d.event_id = p_event_id and d.is_active
  ) then
    return jsonb_build_object('status', 'invalid_device', 'reason', 'device_inactive');
  end if;

  v_payload := jsonb_build_object(
    'event_id', p_event_id,
    'device_id', p_device_id,
    'reading_id', p_reading_id,
    'stage', p_stage,
    'epc', v_epc,
    'captured_at', p_captured_at,
    'antenna', p_antenna,
    'rssi', p_rssi,
    'sequence', p_sequence_no
  );
  v_payload_hash := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.ingest_receipts(device_id, reading_id, status, response, payload, payload_hash)
  values (p_device_id, p_reading_id, 'processing', '{}'::jsonb, v_payload, v_payload_hash)
  on conflict (device_id, reading_id) do nothing;
  if not found then
    select * into v_receipt from public.ingest_receipts r
    where r.device_id = p_device_id and r.reading_id = p_reading_id
    for update;
    if v_receipt.payload_hash is not null and v_receipt.payload_hash <> v_payload_hash then
      return jsonb_build_object(
        'status', 'invalid',
        'reason', 'reading_id_payload_conflict',
        'message', 'El ID de lectura ya existe con otro contenido; se requiere revisión.'
      );
    end if;
    return jsonb_build_object(
      'status', 'duplicate',
      'original_status', v_receipt.status,
      'original_response', v_receipt.response
    );
  end if;

  -- SHARE deja ingresar lecturas concurrentes, pero serializa el cambio de estado del evento.
  select e.name, e.status, e.minimum_rssi
  into v_event_name, v_event_status, v_minimum_rssi
  from public.events e where e.id = p_event_id
  for share;
  if v_event_status is distinct from 'open' then
    v_status := 'event_closed';
    v_effect := 'blocked';
    v_response := jsonb_build_object(
      'status', v_status,
      'reason', case when v_event_status = 'draft' then 'event_draft' else 'event_not_open' end,
      'event_id', p_event_id,
      'event_name', v_event_name,
      'event_status', v_event_status,
      'can_receive', false,
      'message', 'El evento "' || coalesce(v_event_name, '(sin nombre)') || '" está '
        || case v_event_status
          when 'draft' then 'en Borrador'
          when 'open' then 'En curso'
          when 'closed' then 'Cerrado'
          when 'published' then 'Publicado'
          else 'en estado desconocido'
        end
        || '. La recepción RFID remota solo acepta lecturas cuando el estado es En curso.'
    );
  elsif p_rssi < v_minimum_rssi then
    v_status := 'below_threshold';
    v_effect := 'rejected';
  else
    select p.id into v_participant_id
    from public.event_participants p
    where p.event_id = p_event_id and p.chip = v_epc;
    if v_participant_id is null then
      v_status := 'unknown_chip';
      v_effect := 'rejected';
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
        v_effect := 'ignored';
      else
        v_status := 'accepted';
        v_effect := 'accepted';
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

  if v_response is null then
    v_response := jsonb_build_object(
      'status', v_status,
      'reason', v_status,
      'message', case v_status
        when 'accepted' then 'Lectura aceptada y aplicada a la marca vigente.'
        when 'below_threshold' then 'La señal recibida está bajo el umbral RSSI del evento.'
        when 'unknown_chip' then 'El chip no está asociado a la nómina del evento.'
        when 'later_than_current' then 'La lectura es posterior a la marca RFID vigente; se conserva la marca anterior.'
        when 'manual_override' then 'Existe una corrección manual vigente; la lectura RFID queda ignorada.'
        else 'La lectura requiere revisión.'
      end,
      'minimum_rssi', v_minimum_rssi
    );
  end if;
  v_response := v_response || jsonb_build_object('effect', v_effect);
  update public.ingest_receipts set status = v_status, response = v_response
  where device_id = p_device_id and reading_id = p_reading_id;
  return v_response;
end;
$$;
revoke all on function public.ingest_rfid_reading(uuid, uuid, uuid, text, text, timestamptz, smallint, smallint, bigint) from public, anon, authenticated;
grant execute on function public.ingest_rfid_reading(uuid, uuid, uuid, text, text, timestamptz, smallint, smallint, bigint) to service_role;

create or replace function public.get_event_ingest_health(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_health jsonb;
begin
  if not public.owns_event(p_event_id) then
    raise exception 'Event not found or access denied' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'received', count(*),
    'accepted', count(*) filter (where r.status = 'accepted'),
    'ignored', count(*) filter (where r.status in ('later_than_current', 'manual_override')),
    'blocked', count(*) filter (where r.status = 'event_closed'),
    'rejected', count(*) filter (where r.status in ('unknown_chip', 'below_threshold', 'invalid', 'invalid_device')),
    'last_received_at', max(r.received_at),
    'first_incident_at', min(r.received_at) filter (where r.status not in ('accepted', 'later_than_current', 'manual_override')),
    'last_incident_at', max(r.received_at) filter (where r.status not in ('accepted', 'later_than_current', 'manual_override')),
    'last_device_contact_at', (select max(d2.last_seen_at) from public.reader_devices d2 where d2.event_id = p_event_id),
    'recent', coalesce((
      select jsonb_agg(item order by received_at desc)
      from (
        select jsonb_build_object(
          'reading_id', r2.reading_id,
          'receipt_id', r2.id,
          'device_name', d.name,
          'status', r2.status,
          'reason', r2.response ->> 'reason',
          'message', r2.response ->> 'message',
          'captured_at', r2.payload ->> 'captured_at',
          'stage', r2.payload ->> 'stage',
          'received_at', r2.received_at,
          'reprocessable', r2.status in ('event_closed', 'unknown_chip'),
          'payload_available', r2.payload is not null
        ) as item, r2.received_at
        from public.ingest_receipts r2
        join public.reader_devices d on d.id = r2.device_id
        where d.event_id = p_event_id and r2.status not in ('accepted', 'later_than_current', 'manual_override')
        order by r2.received_at desc
        limit 50
      ) incidents
    ), '[]'::jsonb),
    'reprocess_history', coalesce((
      select jsonb_agg(item order by created_at desc)
      from (
        select jsonb_build_object(
          'reading_id', h.reading_id,
          'device_name', d.name,
          'previous_status', h.previous_status,
          'result_status', h.result_status,
          'reason', h.reason,
          'created_at', h.created_at
        ) as item, h.created_at
        from public.ingest_receipt_reprocess_audit h
        join public.reader_devices d on d.id = h.device_id
        where h.event_id = p_event_id
        order by h.created_at desc
        limit 50
      ) changes
    ), '[]'::jsonb)
  ) into v_health
  from public.ingest_receipts r
  join public.reader_devices d on d.id = r.device_id
  where d.event_id = p_event_id;
  return coalesce(v_health, '{}'::jsonb);
end;
$$;
revoke all on function public.get_event_ingest_health(uuid) from public, anon;
grant execute on function public.get_event_ingest_health(uuid) to authenticated;

create or replace function public.reprocess_ingest_receipts(
  p_event_id uuid,
  p_receipt_ids bigint[],
  p_reason text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_recovery_payloads jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_status text;
  v_receipt public.ingest_receipts%rowtype;
  v_receipt_id bigint;
  v_device_event_id uuid;
  v_payload jsonb;
  v_recovery jsonb;
  v_participant_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_updated_id uuid;
  v_captured_at timestamptz;
  v_rssi smallint;
  v_minimum_rssi smallint;
  v_stage text;
  v_epc text;
  v_status text;
  v_response jsonb;
  v_results jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_unique_count integer;
begin
  if not public.owns_event(p_event_id) then
    raise exception 'Event not found or access denied' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 5 and 200 then
    raise exception 'Ingrese un motivo de entre 5 y 200 caracteres' using errcode = '22023';
  end if;
  if p_receipt_ids is null or cardinality(p_receipt_ids) < 1 or cardinality(p_receipt_ids) > 100
      or p_window_start is null or p_window_end is null or p_window_start >= p_window_end
      or p_recovery_payloads is null or jsonb_typeof(p_recovery_payloads) <> 'array' then
    raise exception 'Selección o ventana temporal inválida' using errcode = '22023';
  end if;
  if jsonb_array_length(p_recovery_payloads) > 100 then
    raise exception 'Adjunta hasta 100 archivos de recuperación' using errcode = '22023';
  end if;

  select e.status into v_event_status from public.events e where e.id = p_event_id for share;
  if v_event_status is distinct from 'open' then
    raise exception 'Abra la recepción del evento antes de reprocesar lecturas' using errcode = '23514';
  end if;
  select e.minimum_rssi into v_minimum_rssi from public.events e where e.id = p_event_id;

  select count(distinct receipt_id) into v_unique_count
  from unnest(p_receipt_ids) as selected(receipt_id);
  if v_unique_count <> cardinality(p_receipt_ids) then
    raise exception 'La selección repite recibos' using errcode = '22023';
  end if;

  foreach v_receipt_id in array p_receipt_ids loop
    select r.* into v_receipt
    from public.ingest_receipts r
    join public.reader_devices d on d.id = r.device_id
    where r.id = v_receipt_id and d.event_id = p_event_id
    for update of r;
    if not found then
      raise exception 'No se encontró una lectura seleccionada' using errcode = 'P0002';
    end if;
    if v_receipt.status not in ('event_closed', 'unknown_chip') then
      raise exception 'La lectura % no está disponible para reprocesamiento', v_receipt.reading_id using errcode = '23514';
    end if;

    v_payload := v_receipt.payload;
    if v_payload is null then
      select item into v_recovery
      from jsonb_array_elements(p_recovery_payloads) as recovery(item)
      where item ->> 'event_id' = p_event_id::text
        and item ->> 'device_id' = v_receipt.device_id::text
        and item ->> 'reading_id' = v_receipt.reading_id::text
      limit 1;
      if v_recovery is null then
        raise exception 'El recibo % no conserva payload; adjunta su JSON del outbox local', v_receipt.reading_id using errcode = '23514';
      end if;
      if coalesce(v_recovery ->> 'stage', '') not in ('start', 'finish')
          or coalesce(v_recovery ->> 'epc', '') = ''
          or not coalesce(v_recovery ->> 'antenna', '') ~ '^\d+$'
          or not coalesce(v_recovery ->> 'rssi', '') ~ '^-?\d+$'
          or not coalesce(v_recovery ->> 'sequence', '') ~ '^\d+$'
          or coalesce(v_recovery ->> 'captured_at', '') = '' then
        raise exception 'El payload local de la lectura % no es válido', v_receipt.reading_id using errcode = '22023';
      end if;
      v_epc := upper(regexp_replace(v_recovery ->> 'epc', '\s', '', 'g'));
      v_captured_at := (v_recovery ->> 'captured_at')::timestamptz;
      if char_length(v_epc) > 128 or v_epc = ''
          or (v_recovery ->> 'antenna')::integer not between 1 and 64
          or (v_recovery ->> 'rssi')::integer not between -128 and 0 then
        raise exception 'El payload local de la lectura % está fuera de rango', v_receipt.reading_id using errcode = '22023';
      end if;
      v_payload := jsonb_build_object(
        'event_id', p_event_id,
        'device_id', v_receipt.device_id,
        'reading_id', v_receipt.reading_id,
        'stage', v_recovery ->> 'stage',
        'epc', v_epc,
        'captured_at', v_captured_at,
        'antenna', (v_recovery ->> 'antenna')::smallint,
        'rssi', (v_recovery ->> 'rssi')::smallint,
        'sequence', (v_recovery ->> 'sequence')::bigint
      );
      update public.ingest_receipts
      set payload = v_payload,
          payload_hash = encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex')
      where id = v_receipt.id;
    end if;
    v_captured_at := (v_payload ->> 'captured_at')::timestamptz;
    if v_captured_at < p_window_start or v_captured_at > p_window_end then
      raise exception 'La lectura % está fuera de la ventana autorizada', v_receipt.reading_id using errcode = '23514';
    end if;

    v_stage := v_payload ->> 'stage';
    v_epc := v_payload ->> 'epc';
    v_rssi := (v_payload ->> 'rssi')::smallint;
    v_participant_id := null;
    v_before := null;
    v_after := null;
    v_updated_id := null;
    if v_rssi < v_minimum_rssi then
      v_status := 'below_threshold';
    else
      select p.id into v_participant_id
      from public.event_participants p
      where p.event_id = p_event_id and p.chip = v_epc;
      if v_participant_id is null then
        v_status := 'unknown_chip';
      else
        select to_jsonb(t) into v_before from public.timing_entries t
        where t.event_id = p_event_id and t.participant_id = v_participant_id and t.stage = v_stage
        for update;

        insert into public.timing_entries(event_id, participant_id, stage, captured_at, origin, antenna, rssi, sequence_no, device_id)
        values (
          p_event_id, v_participant_id, v_stage, v_captured_at, 'rfid',
          (v_payload ->> 'antenna')::smallint, v_rssi,
          (v_payload ->> 'sequence')::bigint, v_receipt.device_id
        )
        on conflict (event_id, participant_id, stage) do update
          set captured_at = excluded.captured_at,
              origin = 'rfid', antenna = excluded.antenna, rssi = excluded.rssi,
              sequence_no = excluded.sequence_no, device_id = excluded.device_id,
              operator_id = null, updated_at = now()
          where timing_entries.origin = 'rfid' and excluded.captured_at < timing_entries.captured_at
        returning id, to_jsonb(timing_entries.*) into v_updated_id, v_after;

        if v_updated_id is null then
          v_status := case when v_before ->> 'origin' = 'manual' then 'manual_override' else 'later_than_current' end;
        else
          v_status := 'accepted';
        end if;
        insert into public.timing_entry_audit(
          event_id, participant_id, stage, action, actor_type, actor_id, before_entry, after_entry
        ) values (
          p_event_id, v_participant_id, v_stage,
          case when v_updated_id is null then 'rfid_ignored' else 'rfid_accepted' end,
          'device', v_receipt.device_id, v_before, v_after
        );
      end if;
    end if;

    v_response := jsonb_build_object(
      'status', v_status,
      'effect', case when v_status = 'accepted' then 'accepted'
        when v_status in ('later_than_current', 'manual_override') then 'ignored'
        else 'rejected' end,
      'reprocessed', true,
      'reading_id', v_receipt.reading_id
    );
    insert into public.ingest_receipt_reprocess_audit(
      receipt_id, event_id, device_id, reading_id, operator_id, reason,
      previous_status, previous_response, result_status, result_response
    ) values (
      v_receipt.id, p_event_id, v_receipt.device_id, v_receipt.reading_id, auth.uid(), btrim(p_reason),
      v_receipt.status, v_receipt.response, v_status, v_response
    );
    update public.ingest_receipts
    set status = v_status,
        response = v_response || jsonb_build_object(
          'original_status', v_receipt.status,
          'original_response', v_receipt.response
        ),
        reprocessed_count = reprocessed_count + 1
    where id = v_receipt.id;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'reading_id', v_receipt.reading_id, 'status', v_status
    ));
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('processed', v_count, 'results', v_results);
end;
$$;
revoke all on function public.reprocess_ingest_receipts(uuid, bigint[], text, timestamptz, timestamptz, jsonb) from public, anon;
grant execute on function public.reprocess_ingest_receipts(uuid, bigint[], text, timestamptz, timestamptz, jsonb) to authenticated;
