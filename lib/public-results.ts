import { unstable_cache } from "next/cache";
import { createClient } from "@supabase/supabase-js";

export type PublicStandingRow = {
  event_name: string;
  event_slug: string;
  event_status: string;
  event_timezone: string;
  participant_exists: boolean;
  participant_name: string | null;
  bib: string | null;
  category: string | null;
  category_key: string | null;
  age_bracket: string | null;
  distance: string | null;
  sex: string | null;
  result_status: string | null;
  start_at: string | null;
  finish_at: string | null;
  elapsed_seconds: number | null;
  overall_place: number | null;
  category_place: number | null;
};

export function publicResultsCacheTag(eventSlug: string) {
  return "public-results:" + eventSlug;
}

const PUBLIC_RESULTS_CACHE_SECONDS = 60;

function createPublicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function getCachedPublicEventStanding(eventSlug: string) {
  const loadStanding = unstable_cache(async () => {
    const supabase = createPublicClient();
    if (!supabase) return [];

    const { data, error } = await supabase.rpc("get_public_event_standing", { p_event_slug: eventSlug });
    if (error) throw error;
    return (data ?? []) as PublicStandingRow[];
  }, ["public-event-standing-criteria-v1", eventSlug], {
    tags: [publicResultsCacheTag(eventSlug)],
    revalidate: PUBLIC_RESULTS_CACHE_SECONDS,
  });

  return loadStanding();
}

