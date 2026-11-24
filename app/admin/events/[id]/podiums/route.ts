import { createClient } from "@/lib/supabase/server";
import { buildPodiumGroups, renderPodiumsPdf, type PodiumCandidate } from "@/lib/podium-export";
import { formatDateTime, slugify } from "@/lib/format";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("No autorizado", { status: 401 });
  const { data: event } = await supabase.from("events").select("name,event_date,timezone").eq("id", id).eq("owner_id", user.id).maybeSingle();
  if (!event) return new Response("Evento no encontrado", { status: 404 });
  const { data: policies, error: policyError } = await supabase.from("event_distances").select("distance,award_policy_configured,exclude_general_top3_from_categories").eq("event_id", id);
  if (policyError) return new Response("No se pudieron consultar las políticas de podio", { status: 500 });
  const participants: PodiumCandidate[] = [];
  // Fetch every result; do not silently truncate at Supabase's default row limit.
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from("event_results")
      .select("participant_id,bib,first_name,last_name,team,distance,sex,category,age_bracket,result_status,elapsed_seconds,overall_place,category_place")
      .eq("event_id", id).order("participant_id").range(offset, offset + 499);
    if (error) return new Response("No se pudieron exportar los podios", { status: 500 });
    participants.push(...(data ?? []));
    if (!data || data.length < 500) break;
  }
  const pdf = renderPodiumsPdf({ name: event.name, date: event.event_date ?? "Por definir", exportedAt: formatDateTime(new Date().toISOString(), event.timezone) }, buildPodiumGroups(participants, policies ?? []));
  return new Response(pdf as Uint8Array<ArrayBuffer>, { headers: {
    "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${slugify(event.name) || "evento"}-podios.pdf"`, "Cache-Control": "private, no-store",
  } });
}
