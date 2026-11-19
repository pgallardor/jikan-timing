create or replace function public.record_distance_start_manually(
  p_event_id uuid,
  p_distance text,
  p_captured_at timestamptz,
  p_reason text,
  p_confirm_replace boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_distance text := upper(btrim(p_distance));
  v_distance_started_at timestamptz;
  v_participant_count integer;
  v_existing_count integer;
  v_participant record;
  v_before jsonb;
  v_after jsonb;
  v_entry_id uuid;
  v_count integer := 0;
begin
  if auth.uid() is null or not public.owns_event(p_event_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_distance is null or v_distance = '' or p_captured_at is null then
    raise exception 'Indica una distancia y hora de salida válidas' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'Indica un motivo de al menos 3 caracteres' using errcode = '22023';
  end if;

  select d.started_at into v_distance_started_at
  from public.event_distances d
  where d.event_id = p_event_id and d.distance = v_distance
  for update;
  if not found then
    raise exception 'La distancia no está configurada en este evento' using errcode = 'P0002';
  end if;

  select count(*) into v_participant_count
  from public.event_participants p
  where p.event_id = p_event_id and p.distance = v_distance;
  if v_participant_count = 0 then
    raise exception 'La distancia no tiene corredores' using errcode = 'P0002';
  end if;

  select count(*) into v_existing_count
  from public.timing_entries t
  join public.event_participants p on p.id = t.participant_id and p.event_id = t.event_id
  where t.event_id = p_event_id and t.stage = 'start' and p.distance = v_distance;
  if (v_distance_started_at is not null or v_existing_count > 0) and not coalesce(p_confirm_replace, false) then
    raise exception 'La distancia ya tiene salidas registradas; confirma que deseas reemplazarlas' using errcode = '23505';
  end if;

  for v_participant in
    select p.id
    from public.event_participants p
    where p.event_id = p_event_id and p.distance = v_distance
    order by p.id
    for update
  loop
    select to_jsonb(t) into v_before
    from public.timing_entries t
    where t.event_id = p_event_id and t.participant_id = v_participant.id and t.stage = 'start'
    for update;

    insert into public.timing_entries(event_id, participant_id, stage, captured_at, origin, operator_id)
    values (p_event_id, v_participant.id, 'start', p_captured_at, 'manual', auth.uid())
    on conflict (event_id, participant_id, stage) do update
      set captured_at = excluded.captured_at,
          origin = 'manual',
          antenna = null,
          rssi = null,
          sequence_no = null,
          device_id = null,
          operator_id = auth.uid(),
          updated_at = now()
    returning id, to_jsonb(timing_entries) into v_entry_id, v_after;

    insert into public.timing_entry_audit(
      event_id, participant_id, stage, action, actor_type, actor_id, reason, before_entry, after_entry
    ) values (
      p_event_id, v_participant.id, 'start',
      case when v_before is null then 'manual_created' else 'manual_corrected' end,
      'operator', auth.uid(), btrim(p_reason), v_before, v_after
    );
    v_count := v_count + 1;
  end loop;

  update public.event_distances
  set started_at = p_captured_at
  where event_id = p_event_id and distance = v_distance;

  return v_count;
end;
$$;

revoke all on function public.record_distance_start_manually(uuid, text, timestamptz, text, boolean) from public, anon;
grant execute on function public.record_distance_start_manually(uuid, text, timestamptz, text, boolean) to authenticated;
