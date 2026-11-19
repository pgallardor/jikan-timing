alter table public.event_participants
  add column age smallint check (age is null or age between 0 and 120);

create table public.event_roster_revisions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  revision_no integer not null check (revision_no > 0),
  source_name text not null check (char_length(source_name) between 1 and 255),
  source_kind text not null check (source_kind in ('csv', 'xlsx', 'manual')),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  mapping jsonb not null default '{}'::jsonb,
  row_count integer not null default 0 check (row_count between 0 and 6000),
  added_count integer not null default 0,
  updated_count integer not null default 0,
  unchanged_count integer not null default 0,
  skipped_count integer not null default 0,
  issue_count integer not null default 0,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (event_id, revision_no),
  unique (event_id, id)
);

create table public.event_roster_revision_rows (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  revision_id uuid not null,
  source_row integer not null check (source_row > 0),
  source_sheet text,
  operation text not null check (operation in ('add', 'update', 'unchanged', 'skip')),
  participant_id uuid,
  mapped_fields jsonb not null default '[]'::jsonb,
  expected_values jsonb not null default '{}'::jsonb,
  source_values jsonb not null default '[]'::jsonb,
  normalized_values jsonb not null default '{}'::jsonb,
  before_values jsonb,
  after_values jsonb,
  issues jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (revision_id, source_row),
  foreign key (revision_id, event_id) references public.event_roster_revisions(id, event_id) on delete cascade,
  foreign key (participant_id) references public.event_participants(id) on delete set null
);

create index event_roster_revisions_event_created_idx
  on public.event_roster_revisions(event_id, created_at desc);
create index event_roster_revision_rows_participant_idx
  on public.event_roster_revision_rows(event_id, participant_id, created_at desc);

alter table public.event_roster_revisions enable row level security;
alter table public.event_roster_revision_rows enable row level security;

create policy "Owners can read roster revisions" on public.event_roster_revisions
  for select to authenticated using (public.owns_event(event_id));
create policy "Owners can read roster revision rows" on public.event_roster_revision_rows
  for select to authenticated using (public.owns_event(event_id));
grant select on public.event_roster_revisions, public.event_roster_revision_rows to authenticated;
revoke insert, update, delete, truncate on public.event_roster_revisions, public.event_roster_revision_rows from anon, authenticated;

create or replace function public.protect_started_participant_distance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.distance is distinct from new.distance and exists (
    select 1 from public.event_distances d
    where d.event_id = old.event_id
      and d.distance = old.distance
      and d.started_at is not null
  ) then
    raise exception 'A participant cannot be moved out of a distance that has already started' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger event_participants_protect_started_distance
before update of distance on public.event_participants
for each row execute function public.protect_started_participant_distance();

create or replace function public.import_event_roster(
  p_event_id uuid,
  p_rows jsonb,
  p_source_name text,
  p_source_kind text,
  p_source_sha256 text,
  p_mapping jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_revision_id uuid;
  v_revision_no integer;
  v_row jsonb;
  v_person jsonb;
  v_operation text;
  v_fields jsonb;
  v_expected jsonb;
  v_expected_key text;
  v_participant_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_added integer := 0;
  v_updated integer := 0;
  v_unchanged integer := 0;
  v_skipped integer := 0;
  v_issues integer := 0;
  v_reviewable integer := 0;
  v_source_row integer;
begin
  if v_user_id is null or not public.owns_event(p_event_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 6000 then
    raise exception 'Import must contain between 1 and 6000 reviewed rows' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(p_rows) as x(value)
      where value->>'operation' in ('add', 'update')) > 5000 then
    raise exception 'Import cannot change more than 5000 participants' using errcode = '22023';
  end if;
  if p_source_name is null or char_length(p_source_name) not between 1 and 255
      or p_source_kind is null or p_source_kind not in ('csv', 'xlsx', 'manual')
      or p_source_sha256 is null
      or p_source_sha256 !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(p_mapping) is distinct from 'object'
      or pg_column_size(p_mapping) > 32768 then
    raise exception 'Invalid import source metadata' using errcode = '22023';
  end if;

  perform 1 from public.events where id = p_event_id for update;
  select coalesce(max(revision_no), 0) + 1 into v_revision_no
  from public.event_roster_revisions where event_id = p_event_id;

  insert into public.event_roster_revisions(
    event_id, revision_no, source_name, source_kind, source_sha256, mapping,
    row_count, created_by
  ) values (
    p_event_id, v_revision_no, p_source_name, p_source_kind, p_source_sha256,
    p_mapping, jsonb_array_length(p_rows), v_user_id
  ) returning id into v_revision_id;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_operation := v_row->>'operation';
    v_source_row := (v_row->>'source_row')::integer;
    v_person := coalesce(v_row->'participant', '{}'::jsonb);
    v_fields := coalesce(v_row->'mapped_fields', '[]'::jsonb);
    v_expected := coalesce(v_row->'expected_values', '{}'::jsonb);
    v_participant_id := nullif(v_person->>'participant_id', '')::uuid;
    v_before := null;
    v_after := null;

    if v_operation is null or v_operation not in ('add', 'update', 'unchanged', 'skip') or v_source_row < 1
        or jsonb_typeof(v_row->'source_values') is distinct from 'array'
        or jsonb_typeof(v_row->'issues') is distinct from 'array'
        or jsonb_typeof(v_fields) is distinct from 'array'
        or jsonb_typeof(v_expected) is distinct from 'object'
        or exists (
          select 1 from jsonb_array_elements_text(v_fields) as f(value)
          where value not in ('bib', 'chip', 'first_name', 'last_name', 'sex', 'rut', 'distance', 'age', 'age_bracket', 'category', 'team')
        ) then
      raise exception 'Invalid reviewed roster row' using errcode = '22023';
    end if;
    if v_operation <> 'skip' then
      v_reviewable := v_reviewable + 1;
    end if;
    if v_participant_id is not null and not exists (
      select 1 from public.event_participants p where p.event_id = p_event_id and p.id = v_participant_id
    ) then
      raise exception 'Participant ID does not belong to this event at source row %', v_source_row using errcode = '22023';
    end if;

    if v_operation in ('add', 'update') then
      if nullif(btrim(v_person->>'first_name'), '') is null then
        raise exception 'Participant name is required at source row %', v_source_row using errcode = '22023';
      end if;
      if v_operation = 'add' then
        if v_participant_id is not null then
          raise exception 'New participant cannot supply a participant ID at source row %', v_source_row using errcode = '22023';
        end if;
        insert into public.event_participants(
          event_id, bib, chip, first_name, last_name, sex, distance, category,
          team, rut, age_bracket, age
        ) values (
          p_event_id,
          nullif(btrim(v_person->>'bib'), ''),
          nullif(upper(regexp_replace(btrim(v_person->>'chip'), '\s', '', 'g')), ''),
          btrim(v_person->>'first_name'),
          nullif(btrim(v_person->>'last_name'), ''),
          case when v_person->>'sex' in ('F', 'M', 'otro', 'no_informado') then v_person->>'sex' else null end,
          nullif(upper(btrim(v_person->>'distance')), ''),
          nullif(btrim(v_person->>'category'), ''),
          nullif(btrim(v_person->>'team'), ''),
          nullif(btrim(v_person->>'rut'), ''),
          nullif(btrim(v_person->>'age_bracket'), ''),
          nullif(v_person->>'age', '')::smallint
        ) returning id, to_jsonb(event_participants) into v_participant_id, v_after;
        v_added := v_added + 1;
      elsif v_operation = 'update' then
        if v_participant_id is null then
          raise exception 'Update requires a stable participant ID at source row %', v_source_row using errcode = '22023';
        end if;
        select to_jsonb(p) into v_before from public.event_participants p
        where p.event_id = p_event_id and p.id = v_participant_id for update;
        if not found then
          raise exception 'Participant ID does not belong to this event at source row %', v_source_row using errcode = '22023';
        end if;
        for v_expected_key in select key from jsonb_object_keys(v_expected) as x(key)
        loop
          if v_before->v_expected_key is distinct from v_expected->v_expected_key then
            raise exception 'Participant changed after preview at source row %; review the roster again', v_source_row using errcode = '40001';
          end if;
        end loop;
        update public.event_participants p set
          bib = case when v_fields ? 'bib' then nullif(btrim(v_person->>'bib'), '') else p.bib end,
          chip = case when v_fields ? 'chip' then nullif(upper(regexp_replace(btrim(v_person->>'chip'), '\s', '', 'g')), '') else p.chip end,
          first_name = case when v_fields ? 'first_name' then btrim(v_person->>'first_name') else p.first_name end,
          last_name = case when v_fields ? 'last_name' then nullif(btrim(v_person->>'last_name'), '') else p.last_name end,
          sex = case when v_fields ? 'sex' then case when v_person->>'sex' in ('F', 'M', 'otro', 'no_informado') then v_person->>'sex' else null end else p.sex end,
          distance = case when v_fields ? 'distance' then nullif(upper(btrim(v_person->>'distance')), '') else p.distance end,
          category = case when v_fields ? 'category' then nullif(btrim(v_person->>'category'), '') else p.category end,
          team = case when v_fields ? 'team' then nullif(btrim(v_person->>'team'), '') else p.team end,
          rut = case when v_fields ? 'rut' then nullif(btrim(v_person->>'rut'), '') else p.rut end,
          age_bracket = case when v_fields ? 'age_bracket' then nullif(btrim(v_person->>'age_bracket'), '') else p.age_bracket end,
          age = case when v_fields ? 'age' then nullif(v_person->>'age', '')::smallint else p.age end
        where p.event_id = p_event_id and p.id = v_participant_id
        returning to_jsonb(p) into v_after;
        if v_before is distinct from v_after then
          v_updated := v_updated + 1;
        else
          v_unchanged := v_unchanged + 1;
          v_operation := 'unchanged';
        end if;
      else
        if v_operation = 'unchanged' then
          v_unchanged := v_unchanged + 1;
          if v_participant_id is not null then
            select to_jsonb(p) into v_after from public.event_participants p
            where p.event_id = p_event_id and p.id = v_participant_id;
          end if;
        else
          v_skipped := v_skipped + 1;
        end if;
      end if;
    elsif v_operation = 'unchanged' then
      if v_participant_id is null then
        raise exception 'Unchanged row requires a participant ID at source row %', v_source_row using errcode = '22023';
      end if;
      select to_jsonb(p) into v_before from public.event_participants p
      where p.event_id = p_event_id and p.id = v_participant_id for update;
      if not found then
        raise exception 'Participant ID does not belong to this event at source row %', v_source_row using errcode = '22023';
      end if;
      for v_expected_key in select key from jsonb_object_keys(v_expected) as x(key)
      loop
        if v_before->v_expected_key is distinct from v_expected->v_expected_key then
          raise exception 'Participant changed after preview at source row %; review the roster again', v_source_row using errcode = '40001';
        end if;
      end loop;
      v_unchanged := v_unchanged + 1;
      v_after := v_before;
    else
      v_skipped := v_skipped + 1;
    end if;

    v_issues := v_issues + jsonb_array_length(v_row->'issues');
    insert into public.event_roster_revision_rows(
      event_id, revision_id, source_row, source_sheet, operation, participant_id, mapped_fields, expected_values,
      source_values, normalized_values, before_values, after_values, issues
    ) values (
      p_event_id, v_revision_id, v_source_row, nullif(v_row->>'source_sheet', ''),
      v_operation, v_participant_id, v_fields, v_expected, v_row->'source_values', v_person,
      v_before, v_after, v_row->'issues'
    );
  end loop;

  if v_reviewable = 0 then
    raise exception 'Resolve or skip rows so at least one participant is imported or updated' using errcode = '22023';
  end if;

  update public.event_roster_revisions set
    added_count = v_added,
    updated_count = v_updated,
    unchanged_count = v_unchanged,
    skipped_count = v_skipped,
    issue_count = v_issues
  where id = v_revision_id;

  return jsonb_build_object(
    'revision', v_revision_no,
    'added', v_added,
    'updated', v_updated,
    'unchanged', v_unchanged,
    'skipped', v_skipped,
    'issues', v_issues
  );
end;
$$;

revoke all on function public.import_event_roster(uuid, jsonb, text, text, text, jsonb) from public, anon;
grant execute on function public.import_event_roster(uuid, jsonb, text, text, text, jsonb) to authenticated;
