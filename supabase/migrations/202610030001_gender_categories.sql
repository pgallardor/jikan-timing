create or replace function public.participant_category_with_gender(p_category text, p_sex text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_category text;
begin
  if p_sex not in ('F', 'M') then
    return nullif(btrim(p_category), '');
  end if;

  v_category := regexp_replace(
    coalesce(p_category, ''),
    '(^|[^[:alnum:]])(f|fem|femenin[oa]|mujer(es)?|female|woman|women|señora|niña|damas?|m|masc|masculin[oa]|h|hombre(s)?|var[oó]n(es)?|male|man|men|señor|niño)([^[:alnum:]]|$)',
    '\1',
    'gi'
  );
  v_category := regexp_replace(v_category, '^[[:space:],;:|/·—–-]+|[[:space:],;:|/·—–-]+$', '', 'g');
  v_category := regexp_replace(v_category, '[[:space:]]{2,}', ' ', 'g');
  v_category := btrim(v_category);

  return case when v_category = '' then '' else v_category || ' ' end
    || case when p_sex = 'F' then 'Damas' else 'Varones' end;
end;
$$;

create or replace function public.set_participant_category_by_gender()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.sex in ('F', 'M') then
    new.category := public.participant_category_with_gender(new.category, new.sex);
  end if;
  return new;
end;
$$;

create trigger event_participants_gender_category
before insert or update of sex, category on public.event_participants
for each row execute function public.set_participant_category_by_gender();

update public.event_participants
set category = public.participant_category_with_gender(category, sex)
where sex in ('F', 'M')
  and category is distinct from public.participant_category_with_gender(category, sex);
