import type { SupabaseClient } from "@supabase/supabase-js";
import { categoryIdentity, categoryLabel, type ClassificationFields } from "./classification";
import { normalizeDistance } from "./participant-category";

export const ROSTER_PAGE_SIZE = 50;
export type RosterSearchParams = Record<string, string | string[] | undefined>;
export type RosterFilters = {
  bib: string;
  chip: string;
  sex: string;
  distance: string;
  category: string;
  page: number;
};
export type RosterCategoryOption = {
  value: string;
  label: string;
  sex: string;
  ageBrackets: string[];
};

function first(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

export function parseRosterFilters(params: RosterSearchParams): RosterFilters {
  const page = Number(first(params.roster_page));
  return {
    bib: first(params.roster_bib),
    chip: first(params.roster_chip).replace(/\s/g, ""),
    sex: first(params.roster_sex),
    distance: first(params.roster_distance),
    category: first(params.roster_category),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

// Retain raw bracket variants so legacy values match the same displayed category.
// The original category column is provenance, not the competition category.
export function rosterCategoryOptions(people: ClassificationFields[]): RosterCategoryOption[] {
  const options = new Map<string, RosterCategoryOption>();
  for (const person of people) {
    const value = categoryIdentity(person);
    const label = categoryLabel(person);
    if (!value || !label || !person.sex || !person.age_bracket) continue;
    const option = options.get(value) ?? { value, label, sex: person.sex, ageBrackets: [] };
    if (!option.ageBrackets.includes(person.age_bracket)) option.ageBrackets.push(person.age_bracket);
    options.set(value, option);
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label, "es", { numeric: true }));
}

export function rosterPageHref(eventId: string, filters: RosterFilters, page = filters.page) {
  const params = new URLSearchParams({ tab: "roster" });
  for (const field of ["bib", "chip", "sex", "distance", "category"] as const) {
    if (filters[field]) params.set(`roster_${field}`, filters[field]);
  }
  if (page > 1) params.set("roster_page", String(page));
  return `/admin/events/${encodeURIComponent(eventId)}?${params}`;
}

export async function fetchRosterPage(
  supabase: SupabaseClient,
  eventId: string,
  filters: RosterFilters,
  categories: RosterCategoryOption[],
  distances: string[] = [],
) {
  const empty = { ids: [] as string[], count: 0, page: 1, pages: 1, error: null };
  const category = categories.find((option) => option.value === filters.category);
  if (filters.category && (!category || (filters.sex && filters.sex !== category.sex))) return empty;

  const query = (head: boolean) => {
    let request = supabase.from("event_participants").select("id", { count: "exact", head }).eq("event_id", eventId);
    // Separate column filters avoid interpolating user text into PostgREST .or().
    const contains = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
    if (filters.bib) request = request.ilike("bib", contains(filters.bib));
    if (filters.chip) request = request.ilike("chip", contains(filters.chip));
    if (filters.sex === "unspecified") request = request.is("sex", null);
    else if (filters.sex) request = request.eq("sex", filters.sex);
    if (filters.distance) {
      const variants = [...new Set([filters.distance, ...distances.filter((distance) => normalizeDistance(distance) === filters.distance)])];
      request = request.in("distance", variants);
    }
    if (category) request = request.eq("sex", category.sex).in("age_bracket", category.ageBrackets);
    return request;
  };

  // Count first to clamp stale/bookmarked pages, including after a participant is removed.
  const { count, error: countError } = await query(true);
  if (countError) return { ...empty, error: countError };
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / ROSTER_PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  if (!total) return empty;
  const start = (page - 1) * ROSTER_PAGE_SIZE;
  const { data, error } = await query(false)
    .order("bib", { ascending: true, nullsFirst: false }).order("id")
    .range(start, start + ROSTER_PAGE_SIZE - 1);
  return { ids: (data ?? []).map((row) => String(row.id)), count: total, page, pages, error };
}
