create or replace function public.get_public_available_events()
returns table (
  name text,
  slug text,
  status text,
  start_at timestamptz,
  timezone text
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.name, e.slug, e.status, e.start_at, e.timezone
  from public.events as e
  where e.status in ('open', 'closed', 'published')
  order by
    case when e.status = 'open' then 0 else 1 end,
    e.start_at desc nulls last,
    e.created_at desc;
$$;

revoke all on function public.get_public_available_events() from public;
grant execute on function public.get_public_available_events() to anon, authenticated;
