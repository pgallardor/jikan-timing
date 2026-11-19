create or replace function public.import_finish_corrections(
  p_event_id uuid,
  p_corrections jsonb,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correction record;
  v_participant_id uuid;
  v_start_at timestamptz;
  v_count integer := 0;
begin
  if auth.uid() is null or not public.owns_event(p_event_id) then
    raise exception 'No tienes permiso para modificar este evento.' using errcode = '42501';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 or char_length(p_reason) > 200 then
    raise exception 'Indica un motivo de entre 3 y 200 caracteres.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_corrections) is distinct from 'array' then
    raise exception 'El archivo debe contener una lista de rectificaciones.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_corrections) not between 1 and 5000 then
    raise exception 'El archivo debe tener entre 1 y 5000 rectificaciones.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_corrections) as x(bib text, elapsed_milliseconds bigint, csv_row integer)
    group by btrim(x.bib)
    having count(*) > 1
  ) then
    raise exception 'El archivo contiene dorsales repetidos.' using errcode = '22023';
  end if;

  for v_correction in
    select btrim(x.bib) as bib, x.elapsed_milliseconds, x.csv_row
    from jsonb_to_recordset(p_corrections) as x(bib text, elapsed_milliseconds bigint, csv_row integer)
  loop
    if v_correction.bib is null or v_correction.bib = '' then
      raise exception 'Falta el dorsal en la fila % del CSV.', coalesce(v_correction.csv_row, 0) using errcode = '22023';
    end if;
    if v_correction.elapsed_milliseconds is null or v_correction.elapsed_milliseconds not between 1 and 31536000000 then
      raise exception 'El tiempo de la fila % debe ser mayor que cero y no superar 365 días.', coalesce(v_correction.csv_row, 0) using errcode = '22023';
    end if;
    if v_correction.csv_row is null or v_correction.csv_row < 2 then
      raise exception 'Número de fila inválido en el CSV.' using errcode = '22023';
    end if;

    select p.id, s.captured_at into v_participant_id, v_start_at
    from public.event_participants p
    left join public.timing_entries s
      on s.event_id = p.event_id and s.participant_id = p.id and s.stage = 'start'
    where p.event_id = p_event_id and p.bib = v_correction.bib;
    if not found then
      raise exception 'El dorsal % de la fila % no existe en este evento.', v_correction.bib, v_correction.csv_row using errcode = 'P0002';
    end if;
    if v_start_at is null then
      raise exception 'El dorsal % de la fila % no tiene salida registrada.', v_correction.bib, v_correction.csv_row using errcode = '22023';
    end if;

    perform public.record_manual_entry(
      p_event_id,
      v_participant_id,
      'finish',
      v_start_at + (v_correction.elapsed_milliseconds * interval '1 millisecond'),
      btrim(p_reason) || ' (CSV, fila ' || v_correction.csv_row || ')'
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.import_finish_corrections(uuid, jsonb, text) from public, anon;
grant execute on function public.import_finish_corrections(uuid, jsonb, text) to authenticated;
