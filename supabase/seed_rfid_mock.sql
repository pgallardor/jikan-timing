-- Fixture RFID local. No se ejecuta automáticamente con db reset.
-- Asigna chips decimales 7751-7760 a 10 participantes; 7761 queda reservado como repuesto.
-- Deja el evento abierto y registra una salida común para probar lecturas de llegada.
do $$
declare
  v_owner uuid;
  v_event_id uuid;
  v_start timestamptz := transaction_timestamp();
begin
  select u.id into v_owner
  from auth.users u
  join public.events e on e.owner_id = u.id
  group by u.id, u.created_at
  order by u.created_at desc
  limit 1;
  if v_owner is null then
    raise exception 'No se encontró una cuenta local con eventos para asignar el mock.';
  end if;
  if exists (select 1 from public.events where slug = 'mock-rfid-podios-20261004') then
    raise exception 'Ya existe mock-rfid-podios-20261004; no se modificó ningún dato.';
  end if;

  insert into public.events (
    owner_id, name, slug, organizer, timezone, start_at, status, minimum_rssi
  ) values (
    v_owner, 'Mock RFID · Podios por categoría', 'mock-rfid-podios-20261004',
    'Prueba local', 'America/Santiago', v_start, 'open', -70
  ) returning id into v_event_id;

  insert into public.event_participants (
    event_id, bib, chip, first_name, last_name, sex, distance, category, team
  ) values
    (v_event_id, '101', '7751', 'Emilia',    'Rojas',    null, '3KM', 'Juvenil', 'Mock local'),
    (v_event_id, '102', '7752', 'Vicente',   'Soto',     null, '3KM', 'Juvenil', 'Mock local'),
    (v_event_id, '103', '7753', 'Antonia',   'Muñoz',    null, '3KM', 'Juvenil', 'Mock local'),
    (v_event_id, '201', '7754', 'Lucas',     'Pérez',    null, '3KM', 'Adulto',  'Mock local'),
    (v_event_id, '202', '7755', 'Camila',    'Fuentes',  null, '3KM', 'Adulto',  'Mock local'),
    (v_event_id, '203', '7756', 'Matías',    'Castro',   null, '3KM', 'Adulto',  'Mock local'),
    (v_event_id, '204', '7757', 'Valentina', 'Silva',    null, '3KM', 'Adulto',  'Mock local'),
    (v_event_id, '301', '7758', 'Benjamín',  'Torres',   null, '3KM', 'Máster',  'Mock local'),
    (v_event_id, '302', '7759', 'Sofía',     'Reyes',    null, '3KM', 'Máster',  'Mock local'),
    (v_event_id, '303', '7760', 'Diego',     'Navarro',  null, '3KM', 'Máster',  'Mock local');

  update public.event_distances
  set official_start_at = v_start, started_at = v_start
  where event_id = v_event_id and distance = '3KM';

  with new_entries as (
    insert into public.timing_entries (
      event_id, participant_id, stage, captured_at, origin, operator_id
    )
    select v_event_id, p.id, 'start', v_start, 'manual', v_owner
    from public.event_participants p
    where p.event_id = v_event_id
    returning *
  )
  insert into public.timing_entry_audit (
    event_id, participant_id, stage, action, actor_type, actor_id, reason, after_entry
  )
  select n.event_id, n.participant_id, 'start', 'official_distance_start',
    'operator', v_owner, 'Salida común mock local 3KM', to_jsonb(n)
  from new_entries n;
end;
$$;
