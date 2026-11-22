-- Exclusion is an event-distance policy, independent of where age/category
-- information was imported. General winners must not occupy category places.
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
        and coalesce(o.overall_place, 4) <= 3)
  )
  select o.participant_id, o.overall_place, c.category_place
  from overall_places o left join category_places c on c.participant_id = o.participant_id;
$$;
revoke all on function public.calculate_event_participant_places(uuid) from public, anon, authenticated, service_role;

-- Existing snapshots may still contain general winners in category places.
update public.event_podium_snapshots set dirty = true where dirty is distinct from true;
