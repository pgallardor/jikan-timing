-- Rebuild a local-only public standing fixture. Run manually with:
-- supabase db query --local --file supabase/seed_demo.sql
do $$
declare
  v_start timestamptz := date_trunc('minute', now()) - interval '2 hours';
begin

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'demo-owner@crono.local', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
)
on conflict (id) do nothing;

delete from public.events where id = '10000000-0000-4000-8000-000000000001';

insert into public.events (
  id, owner_id, name, slug, organizer, timezone, start_at, status,
  qr_show_name, qr_show_bib, qr_show_category
) values (
  '10000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'Vuelta al Parque · Evento Demo', 'demo-vuelta-parque', 'Organización Demo',
  'America/Santiago', date_trunc('minute', now()) - interval '2 hours', 'closed',
  true, true, true
);

insert into public.event_participants (event_id, bib, chip, first_name, last_name, sex, category)
values
  ('10000000-0000-4000-8000-000000000001', '42',  'DEMO0001', 'Álvaro',     'Pérez',   'M', 'Todo competidor'),
  ('10000000-0000-4000-8000-000000000001', '101', 'DEMO0002', 'María',      'Rojas',   'F', 'Damas 35-44'),
  ('10000000-0000-4000-8000-000000000001', '7',   'DEMO0003', 'Javiera',    'Muñoz',   'F', 'Damas 35-44'),
  ('10000000-0000-4000-8000-000000000001', '84',  'DEMO0004', 'Tomás',      'García',  'M', 'Todo competidor'),
  ('10000000-0000-4000-8000-000000000001', '15',  'DEMO0005', 'Camila',     'Soto',    'F', 'Damas 35-44'),
  ('10000000-0000-4000-8000-000000000001', '203', 'DEMO0006', 'Nicolás',    'Vargas',  'M', 'Máster A'),
  ('10000000-0000-4000-8000-000000000001', '9',   'DEMO0007', 'Francisca',  'Díaz',    'F', 'Todo competidor'),
  ('10000000-0000-4000-8000-000000000001', '66',  'DEMO0008', 'Matías',     'López',   'M', 'Juvenil'),
  ('10000000-0000-4000-8000-000000000001', '3',   'DEMO0009', 'Sofía',      'Castro',  'F', 'Damas 35-44'),
  ('10000000-0000-4000-8000-000000000001', '58',  'DEMO0010', 'Benjamín',   'Fuentes', 'M', 'Máster A'),
  ('10000000-0000-4000-8000-000000000001', '112', 'DEMO0011', 'Antonia',    'Torres',  'F', 'Juvenil'),
  ('10000000-0000-4000-8000-000000000001', '25',  'DEMO0012', 'Diego',      'Morales', 'M', 'Todo competidor'),
  ('10000000-0000-4000-8000-000000000001', '300', 'DEMO0013', 'Josefa',     'Silva',   'F', 'Damas 35-44'),
  ('10000000-0000-4000-8000-000000000001', '301', 'DEMO0014', 'Gabriel',   'Reyes',   'M', 'Todo competidor'),
  ('10000000-0000-4000-8000-000000000001', '302', null,        'Corredor',   'Sin chip', null, null);

insert into public.timing_entries (event_id, participant_id, stage, captured_at, origin)
select '10000000-0000-4000-8000-000000000001', p.id, 'start', v_start, 'manual'
from public.event_participants p
where p.event_id = '10000000-0000-4000-8000-000000000001'
  and p.bib <> '301';

with finishers (bib, seconds) as (
  values
    ('42', 1890), ('101', 1902), ('9', 1988), ('84', 1960), ('58', 2015),
    ('7', 2055), ('15', 2120), ('203', 2200), ('66', 2220), ('25', 2260),
    ('3', 2310), ('112', 2390)
)
insert into public.timing_entries (event_id, participant_id, stage, captured_at, origin)
select '10000000-0000-4000-8000-000000000001', p.id, 'finish', v_start + make_interval(secs => f.seconds), 'manual'
from public.event_participants p
join finishers f on f.bib = p.bib
where p.event_id = '10000000-0000-4000-8000-000000000001';

end;
$$;
