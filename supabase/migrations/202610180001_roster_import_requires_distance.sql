create or replace function public.require_roster_import_distance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_distance text;
begin
  if new.operation in ('add', 'update') then
    select p.distance into v_distance
    from public.event_participants p
    where p.event_id = new.event_id and p.id = new.participant_id;

    if nullif(btrim(v_distance), '') is null then
      raise exception 'Participant distance is required at source row %', new.source_row
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.require_roster_import_distance() from public;

create trigger event_roster_revision_rows_require_distance
before insert on public.event_roster_revision_rows
for each row execute function public.require_roster_import_distance();
