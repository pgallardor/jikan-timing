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
    return jsonb_build_object(
      'status', 'duplicate',
      'original_status', v_receipt.status,
      'original_response', v_receipt.response
    );
  end if;

  select e.name, e.status, e.minimum_rssi
  into v_event_name, v_event_status, v_minimum_rssi
  from public.events e where e.id = p_event_id;
  if v_event_status is distinct from 'open' then
    v_status := 'event_closed';
    v_response := jsonb_build_object(
      'status', v_status,
      'reason', case when v_event_status = 'draft' then 'event_draft' else 'event_not_open' end,
      'event_id', p_event_id,
      'event_name', v_event_name,
      'event_status', v_event_status,
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

  if v_response is null then
    v_response := jsonb_build_object('status', v_status);
  end if;
  update public.ingest_receipts set status = v_status, response = v_response
  where device_id = p_device_id and reading_id = p_reading_id;
  return v_response;
end;
$$;
revoke all on function public.ingest_rfid_reading(uuid, uuid, uuid, text, text, timestamptz, smallint, smallint, bigint) from public, anon, authenticated;
grant execute on function public.ingest_rfid_reading(uuid, uuid, uuid, text, text, timestamptz, smallint, smallint, bigint) to service_role;
