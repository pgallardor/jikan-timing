-- Prepared only. Apply after the operator authorizes migration execution.
create table public.participant_change_audit (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  participant_id uuid not null, -- Deliberately survives removal of the active participant.
  action text not null check (action in ('updated', 'removed', 'dnf_marked', 'dnf_cleared')),
  reason text not null,
  before_values jsonb not null,
  after_values jsonb,
  timing_snapshot jsonb,
  timing_audit_snapshot jsonb,
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index participant_change_audit_event_idx on public.participant_change_audit(event_id, created_at desc);
alter table public.participant_change_audit enable row level security;
revoke all on public.participant_change_audit from public, anon, authenticated;
grant select on public.participant_change_audit to authenticated;
create policy "Owners read participant changes" on public.participant_change_audit
  for select to authenticated using (public.owns_event(event_id));

create or replace function public.change_event_participant(
  p_event_id uuid, p_participant_id uuid, p_action text, p_values jsonb, p_expected jsonb, p_reason text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_key text;
  v_fields jsonb := '["bib","chip","first_name","last_name","sex","rut","distance","age","age_bracket","category","team"]'::jsonb;
begin
  if auth.uid() is null or not public.owns_event(p_event_id) then
    raise exception 'No tienes permiso para modificar este evento.' using errcode = '42501';
  end if;
  perform 1 from public.events where id = p_event_id for update;
  if exists (select 1 from public.events where id = p_event_id and local_operation_status in ('prepared','active')) then
    raise exception 'La operación local conserva la autoridad sobre el evento.' using errcode = '55000';
  end if;
  if p_action is null or p_action not in ('update','remove','dnf','clear_dnf') or p_reason is null
    or char_length(btrim(p_reason)) not between 3 and 200 then
    raise exception 'Acción o motivo inválido (3 a 200 caracteres).' using errcode = '22023';
  end if;
  select to_jsonb(p) into v_before from public.event_participants p
    where p.event_id = p_event_id and p.id = p_participant_id for update;
  if not found then raise exception 'El corredor ya no pertenece a esta nómina.' using errcode = 'P0002'; end if;
  if jsonb_typeof(p_expected) is distinct from 'object' or not (p_expected ?& array['bib','chip','first_name','last_name','sex','rut','distance','age','age_bracket','category','team','dnf_at']) then
    raise exception 'Falta la versión revisada del corredor.' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_expected) loop
    if v_before->v_key is distinct from p_expected->v_key then
      raise exception 'El corredor cambió desde que abriste la nómina. Actualiza y vuelve a revisar.' using errcode = '40001';
    end if;
  end loop;

  if p_action = 'update' then
    if jsonb_typeof(p_values) is distinct from 'object'
      or nullif(btrim(p_values->>'first_name'), '') is null
      or not exists (select 1 from public.event_distances where event_id = p_event_id and distance = p_values->>'distance') then
      raise exception 'Indica un nombre y una distancia configurada en el evento.' using errcode = '22023';
    end if;
    perform public.import_event_roster(p_event_id,
      jsonb_build_array(jsonb_build_object(
        'source_row', 1, 'source_sheet', null, 'source_values', jsonb_build_array(p_reason),
        'mapped_fields', v_fields, 'expected_values', p_expected,
        'participant', p_values || jsonb_build_object('participant_id', p_participant_id),
        'operation', 'update', 'issues', '[]'::jsonb)),
      'Edición manual: ' || btrim(p_reason), 'manual',
      encode(extensions.digest(p_values::text, 'sha256'), 'hex'), '{}'::jsonb);
  elsif p_action = 'remove' then
    -- Preserve the complete row and timing history before cascading active marks.
    insert into public.participant_change_audit(event_id, participant_id, action, reason, before_values, timing_snapshot, timing_audit_snapshot, actor_id)
    values (p_event_id, p_participant_id, 'removed', btrim(p_reason), v_before,
      (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.timing_entries t where event_id = p_event_id and participant_id = p_participant_id),
      (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from public.timing_entry_audit a where event_id = p_event_id and participant_id = p_participant_id), auth.uid());
    delete from public.event_participants where event_id = p_event_id and id = p_participant_id;
    return;
  else
    if p_action = 'dnf' and exists (select 1 from public.timing_entries where event_id = p_event_id and participant_id = p_participant_id and stage = 'finish') then
      raise exception 'El corredor tiene llegada. Anúlala con motivo antes de marcar DNF.' using errcode = '22023';
    end if;
    if (p_action = 'dnf' and v_before->>'dnf_at' is not null) or (p_action = 'clear_dnf' and v_before->>'dnf_at' is null) then
      raise exception 'El estado DNF ya cambió. Actualiza la nómina.' using errcode = '40001';
    end if;
    update public.event_participants set dnf_at = case when p_action = 'dnf' then now() else null end
      where event_id = p_event_id and id = p_participant_id;
  end if;
  select to_jsonb(p) into v_after from public.event_participants p where p.id = p_participant_id;
  insert into public.participant_change_audit(event_id, participant_id, action, reason, before_values, after_values, actor_id)
    values(p_event_id, p_participant_id, case p_action when 'update' then 'updated' when 'dnf' then 'dnf_marked' else 'dnf_cleared' end,
      btrim(p_reason), v_before, v_after, auth.uid());
end;
$$;
revoke all on function public.change_event_participant(uuid,uuid,text,jsonb,jsonb,text) from public, anon;
grant execute on function public.change_event_participant(uuid,uuid,text,jsonb,jsonb,text) to authenticated;

create or replace function public.record_manual_finishes_batch(p_event_id uuid, p_rows jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb;
  v_person public.event_participants%rowtype;
  v_start timestamptz;
  v_finish timestamptz;
  v_captured timestamptz;
  v_count integer := 0;
begin
  if auth.uid() is null or not public.owns_event(p_event_id) then
    raise exception 'No tienes permiso para modificar este evento.' using errcode = '42501';
  end if;
  perform 1 from public.events where id = p_event_id for update;
  if exists (select 1 from public.events where id = p_event_id and local_operation_status in ('prepared','active')) then
    raise exception 'La operación local conserva la autoridad sobre el evento.' using errcode = '55000';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'Planilla inválida.' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) not between 1 and 5000 then raise exception 'Ingresa entre 1 y 5000 llegadas.' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) x group by x->>'participant_id' having count(*) > 1) then
    raise exception 'La planilla repite un corredor.' using errcode = '22023';
  end if;
  -- Any error rolls back the entire batch, including its audit records.
  for v_row in select value from jsonb_array_elements(p_rows) loop
    select * into v_person from public.event_participants
      where event_id = p_event_id and id = (v_row->>'participant_id')::uuid for update;
    if not found or v_person.bib is distinct from v_row->>'bib' then
      raise exception 'El dorsal de la fila % cambió. Revisa la planilla.', v_row->>'row_number' using errcode = '40001';
    end if;
    if v_person.dnf_at is not null then raise exception 'Quita el DNF del dorsal % antes de registrar llegada.', v_person.bib using errcode = '22023'; end if;
    select captured_at into v_start from public.timing_entries where event_id = p_event_id and participant_id = v_person.id and stage = 'start' for update;
    select captured_at into v_finish from public.timing_entries where event_id = p_event_id and participant_id = v_person.id and stage = 'finish' for update;
    if v_start is null or v_start is distinct from (v_row->>'expected_start_at')::timestamptz
      or not (v_row ? 'expected_finish_at') or v_finish is distinct from (v_row->>'expected_finish_at')::timestamptz then
      raise exception 'Las marcas del dorsal % cambiaron desde la revisión. Revisa nuevamente.', v_person.bib using errcode = '40001';
    end if;
    v_captured := (v_row->>'captured_at')::timestamptz;
    if v_captured is null or not isfinite(v_captured) or v_captured <= v_start
      or char_length(btrim(coalesce(v_row->>'reason',''))) not between 3 and 200
      or coalesce((v_row->>'row_number')::integer, 0) < 1 then
      raise exception 'Hora, motivo o fila inválida para el dorsal %.', v_person.bib using errcode = '22023';
    end if;
    perform public.record_manual_entry(p_event_id, v_person.id, 'finish', v_captured,
      btrim(v_row->>'reason') || ' (planilla manual, fila ' || (v_row->>'row_number') || ')');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.record_manual_finishes_batch(uuid,jsonb) from public, anon;
grant execute on function public.record_manual_finishes_batch(uuid,jsonb) to authenticated;
