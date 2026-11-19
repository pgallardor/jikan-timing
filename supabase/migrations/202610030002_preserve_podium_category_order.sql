create or replace function public.participant_category_with_gender(p_category text, p_sex text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_category text := btrim(coalesce(p_category, ''));
  v_gender_pattern text;
  v_opposite_pattern text;
begin
  if p_sex not in ('F', 'M') then
    return nullif(v_category, '');
  end if;

  if p_sex = 'F' then
    v_gender_pattern := '(^|[^[:alnum:]])(f|fem|femenin[oa]|mujer(es)?|female|woman|women|señora|niña|damas?)([^[:alnum:]]|$)';
    v_opposite_pattern := '(^|[^[:alnum:]])(m|masc|masculin[oa]|h|hombre(s)?|var[oó]n(es)?|male|man|men|señor|niño)([^[:alnum:]]|$)';
  else
    v_gender_pattern := '(^|[^[:alnum:]])(m|masc|masculin[oa]|h|hombre(s)?|var[oó]n(es)?|male|man|men|señor|niño|varones)([^[:alnum:]]|$)';
    v_opposite_pattern := '(^|[^[:alnum:]])(f|fem|femenin[oa]|mujer(es)?|female|woman|women|señora|niña|damas?)([^[:alnum:]]|$)';
  end if;

  -- Preserve an already normalized composite label so its order stays distance · sex · age bracket.
  if v_category ~* v_gender_pattern and v_category !~* v_opposite_pattern then
    return nullif(v_category, '');
  end if;

  v_category := regexp_replace(
    v_category,
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
