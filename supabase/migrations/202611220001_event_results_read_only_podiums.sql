-- event_results is read through PostgREST GET in a read-only transaction.
-- Keep this path read-only; the public standing RPC owns snapshot refreshes.
create or replace function public.event_participant_places(p_event_id uuid)
returns table (participant_id uuid, overall_place bigint, category_place bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    if not exists (
      select 1 from public.events e where e.id = p_event_id and e.owner_id = auth.uid()
    ) then
      raise exception 'Not authorized' using errcode = '42501';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' and session_user <> 'postgres' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query select * from public.calculate_event_participant_places(p_event_id);
end;
$$;

revoke all on function public.event_participant_places(uuid) from public, anon, service_role;
grant execute on function public.event_participant_places(uuid) to authenticated;
