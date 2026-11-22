-- DNF is an explicit sporting decision even when timing marks exist.
-- Preserve marks; excluding DNF from ranking must also invalidate cached places.
create or replace function public.participant_result_status(
  p_chip text, p_start_at timestamptz, p_finish_at timestamptz, p_dnf_at timestamptz
)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_dnf_at is not null then 'DNF'
    when p_chip is null then 'SIN CHIP'
    when p_start_at is null then 'SIN SALIDA'
    when p_finish_at is null then 'EN CARRERA'
    else 'FINALIZÓ'
  end;
$$;
revoke all on function public.participant_result_status(text,timestamptz,timestamptz,timestamptz) from public, anon;
grant execute on function public.participant_result_status(text,timestamptz,timestamptz,timestamptz) to authenticated;

create or replace function public.calculate_event_participant_places(p_event_id uuid)
returns table (participant_id uuid, overall_place bigint, category_place bigint)
language sql stable security invoker set search_path = '' as $$
  with base as (
    select p.event_id, p.id as participant_id, p.sex, p.category, p.age_bracket,
      public.result_distance_key(p.distance) as distance_key,
      extract(epoch from (f.captured_at - s.captured_at)) as elapsed_seconds
    from public.event_participants p
    join public.timing_entries s on s.event_id = p.event_id and s.participant_id = p.id and s.stage = 'start'
    join public.timing_entries f on f.event_id = p.event_id and f.participant_id = p.id and f.stage = 'finish'
    where p.event_id = p_event_id and p.dnf_at is null
  ),
  overall_places as (
    select b.participant_id,
      rank() over (partition by b.event_id, b.distance_key, b.sex order by b.elapsed_seconds) as overall_place
    from base b where b.distance_key is not null
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
revoke all on function public.calculate_event_participant_places(uuid) from public, anon, authenticated, service_role;

create trigger event_participants_dnf_podium_snapshot_dirty
after update of dnf_at on public.event_participants
for each row execute function public.mark_event_podium_snapshot_dirty();

update public.event_podium_snapshots set dirty = true where dirty is distinct from true;

create or replace function public.change_event_participant(
  p_event_id uuid, p_participant_id uuid, p_action text, p_values jsonb, p_expected jsonb, p_reason text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_key text;
  v_finish_at timestamptz;
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
    insert into public.participant_change_audit(event_id, participant_id, action, reason, before_values, timing_snapshot, timing_audit_snapshot, actor_id)
    values (p_event_id, p_participant_id, 'removed', btrim(p_reason), v_before,
      (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.timing_entries t where event_id = p_event_id and participant_id = p_participant_id),
      (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from public.timing_entry_audit a where event_id = p_event_id and participant_id = p_participant_id), auth.uid());
    delete from public.event_participants where event_id = p_event_id and id = p_participant_id;
    return;
  else
    if p_action = 'dnf' then
      select captured_at into v_finish_at from public.timing_entries
        where event_id = p_event_id and participant_id = p_participant_id and stage = 'finish' for update;
      if v_finish_at is not null and p_values->'confirm_finished_dnf' is distinct from 'true'::jsonb then
        raise exception 'Confirma expresamente el DNF de este corredor con llegada registrada. Sus marcas se conservarán.' using errcode = '22023';
      end if;
      if p_values->'confirm_finished_dnf' = 'true'::jsonb and (
        v_finish_at is null or v_finish_at is distinct from nullif(p_values->>'expected_finish_at','')::timestamptz
      ) then
        raise exception 'La llegada cambió desde la confirmación. Actualiza la nómina y revisa nuevamente.' using errcode = '40001';
      end if;
    end if;
    if (p_action = 'dnf' and v_before->>'dnf_at' is not null) or (p_action = 'clear_dnf' and v_before->>'dnf_at' is null) then
      raise exception 'El estado DNF ya cambió. Actualiza la nómina.' using errcode = '40001';
    end if;
    update public.event_participants set dnf_at = case when p_action = 'dnf' then now() else null end
      where event_id = p_event_id and id = p_participant_id;
  end if;
  select to_jsonb(p) into v_after from public.event_participants p where p.id = p_participant_id;
  insert into public.participant_change_audit(event_id, participant_id, action, reason, before_values, after_values, timing_snapshot, actor_id)
    values(p_event_id, p_participant_id, case p_action when 'update' then 'updated' when 'dnf' then 'dnf_marked' else 'dnf_cleared' end,
      btrim(p_reason), v_before, v_after,
      case when p_action in ('dnf','clear_dnf') then
        (select coalesce(jsonb_agg(to_jsonb(t) order by t.stage), '[]'::jsonb) from public.timing_entries t where event_id = p_event_id and participant_id = p_participant_id)
      else null end,
      auth.uid());
end;
$$;
revoke all on function public.change_event_participant(uuid,uuid,text,jsonb,jsonb,text) from public, anon;
grant execute on function public.change_event_participant(uuid,uuid,text,jsonb,jsonb,text) to authenticated;
