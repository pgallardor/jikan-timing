create or replace function public.ensure_event_distance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group_changes boolean := tg_op = 'INSERT';
  v_started_at timestamptz;
begin
  if new.distance is null and new.category is not null then
    new.distance := upper(btrim((regexp_match(new.category, '^([0-9]+([.][0-9]+)?[[:space:]]*(KM|K|M))'))[1]));
  end if;
  if tg_op = 'UPDATE' then
    v_group_changes := old.event_id is distinct from new.event_id or old.distance is distinct from new.distance;
  end if;
  if new.distance is not null then
    new.distance := upper(btrim(new.distance));
    if v_group_changes then
      select d.started_at into v_started_at
      from public.event_distances d
      where d.event_id = new.event_id and d.distance = new.distance
      for update;
      if v_started_at is not null then
        raise exception 'Cannot add or move a participant into a distance that has already started' using errcode = '23514';
      end if;
    end if;
    insert into public.event_distances(event_id, distance)
    values (new.event_id, new.distance)
    on conflict (event_id, distance) do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.lock_started_event_distance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.started_at is not null and (
    new.started_at is distinct from old.started_at
    or new.official_start_at is distinct from old.official_start_at
  ) then
    raise exception 'A started distance cannot have its official start changed' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger event_distances_lock_started
before update of official_start_at, started_at on public.event_distances
for each row execute function public.lock_started_event_distance();
