-- RFIDTiming applies the configured RSSI threshold before a reading enters its durable outbox.
-- Keep the legacy event column for transfer compatibility, but prevent the web database from
-- applying a second, independently configured threshold to readings from the authenticated reader.
-- Keep existing event values for compatibility; only choose a conservative default for new events.
create or replace function public.guard_local_operation_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_local_status text;
  v_override text;
begin
  if tg_table_name = 'events' and tg_op = 'UPDATE'
     and (to_jsonb(new) - 'minimum_rssi') is not distinct from (to_jsonb(old) - 'minimum_rssi') then
    return new;
  end if;
  if tg_table_name = 'events' then
    v_event_id := coalesce(new.id, old.id);
  else
    v_event_id := coalesce(new.event_id, old.event_id);
  end if;
  v_override := current_setting('app.d07_transfer_event_id', true);
  if v_override = v_event_id::text then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_table_name = 'reader_devices' and tg_op = 'UPDATE' then
    if (new.event_id, new.name, new.credential_hash, new.is_active) is not distinct from
       (old.event_id, old.name, old.credential_hash, old.is_active) then
      return new;
    end if;
  end if;
  select e.local_operation_status into v_local_status from public.events e where e.id = v_event_id;
  if v_local_status in ('prepared', 'active') then
    raise exception 'Event is controlled by a prepared local operation' using errcode = '55000', detail = 'local_operation_active';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.guard_local_operation_write() from public, anon, authenticated;

alter table public.events alter column minimum_rssi set default -120;

comment on column public.events.minimum_rssi is
  'Deprecated compatibility field. RFIDTiming filters signal strength locally before upload.';
