import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { bearerToken, createBearerClient } from "@/lib/supabase/bearer";
import { canonicalJson, D07_FORMAT, D07_VERSION, formatLocalEventDate, packageHash } from "@/lib/d07-transfer";

function failure(status: number, message: string) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get("origin");
  const token = bearerToken(request);
  if (!token && (!origin || origin !== new URL(request.url).origin)) return failure(403, "Origen de solicitud no válido.");
  const supabase = token ? createBearerClient(token) : await createClient();
  const { data: { user }, error: authError } = token
    ? await supabase.auth.getUser(token)
    : await supabase.auth.getUser();
  if (authError || !user) return failure(401, "Inicia sesión para preparar este evento offline.");
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return failure(400, "Identidad de evento no válida.");
  const { data: currentEvent, error: currentEventError } = await supabase.from("events").select("event_date,start_at,timezone").eq("id", id).maybeSingle();
  if (currentEventError || !currentEvent) return failure(404, "Evento no encontrado o sin permisos.");
  if (!currentEvent.event_date && !currentEvent.start_at) return failure(409, "Completa la fecha del evento antes de descargar una preparación local.");

  const requestedOperationId = crypto.randomUUID();
  const { data: operation, error: operationError } = await supabase.rpc("begin_local_operation", {
    p_event_id: id,
    p_operation_id: requestedOperationId,
  });
  if (operationError || !operation) return failure(operationError?.code === "42501" ? 403 : 409, operationError?.message ?? "No se pudo reservar la operación local.");
  const operationData = operation as { operation_id?: string; status?: string; source_revision?: string };
  if (!operationData.operation_id) return failure(409, "La operación remota no devolvió su identidad.");
  const releaseNewReservation = async (reason: string) => {
    if (operationData.operation_id !== requestedOperationId) return;
    await supabase.rpc("release_local_operation", {
      p_event_id: id,
      p_reason: reason,
      p_confirm_unpublished: true,
    });
  };

  const [eventResult, participantsResult, distancesResult, rosterRevisionResult] = await Promise.all([
    supabase.from("events").select("id,name,organizer,timezone,event_date,start_at,status,minimum_rssi,qr_show_name,qr_show_bib,qr_show_category,updated_at,local_operation_status,local_published_revision").eq("id", id).maybeSingle(),
    supabase.from("event_participants").select("id,bib,chip,first_name,last_name,sex,category,team,distance,age,age_bracket,dnf_at,public_token").eq("event_id", id).order("id").range(0, 5000),
    supabase.from("event_distances").select("distance,official_start_at,started_at,exclude_general_top3_from_categories,award_policy_configured").eq("event_id", id).order("distance"),
    supabase.from("event_roster_revisions").select("revision_no").eq("event_id", id).order("revision_no", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const queryError = eventResult.error ?? participantsResult.error ?? distancesResult.error ?? rosterRevisionResult.error;
  if (queryError || !eventResult.data || !participantsResult.data?.length || participantsResult.data.length > 5000 || !distancesResult.data?.length) {
    await releaseNewReservation("Falló la lectura de preparación web");
    return failure(409, queryError?.message ?? "El evento necesita definición, distancias y hasta 5000 participantes antes de prepararse.");
  }
  const event = eventResult.data;
  if (event.local_operation_status !== "prepared" && event.local_operation_status !== "active") {
    await releaseNewReservation("La reserva no quedó activa");
    return failure(409, "El evento no conserva una reserva de operación local activa.");
  }
  const sourceRevision = `roster-${rosterRevisionResult.data?.revision_no ?? 0}:${event.updated_at}`;
  const pkg: Record<string, unknown> = {
    format: D07_FORMAT,
    version: D07_VERSION,
    kind: "preparation",
    manifest: {
      operation_id: operationData.operation_id,
      source_revision: sourceRevision,
      operator_id: user.id,
      policy_version: "compat_actual_v1@1",
    },
    event: {
      id: event.id,
      name: event.name,
      organizer: event.organizer,
      event_date: formatLocalEventDate(event.event_date, event.start_at, event.timezone),
      start_at: event.start_at,
      timezone: event.timezone,
      status: event.status,
      minimum_rssi: event.minimum_rssi,
      qr_show_name: event.qr_show_name,
      qr_show_bib: event.qr_show_bib,
      qr_show_category: event.qr_show_category,
    },
    distances: distancesResult.data.map((distance) => ({
      distance: distance.distance,
      official_start_at: distance.official_start_at,
      started_at: distance.started_at,
      exclude_general_top3_from_categories: distance.exclude_general_top3_from_categories,
      award_policy_configured: distance.award_policy_configured,
    })),
    participants: participantsResult.data,
    policy: { preset_id: "compat_actual_v1", revision: "1", award_rules: [] },
  };
  pkg.sha256 = packageHash(pkg);
  const { error: hashError } = await supabase.rpc("record_local_preparation_hash", {
    p_event_id: id,
    p_operation_id: operationData.operation_id,
    p_package_hash: pkg.sha256,
    p_source_revision: sourceRevision,
  });
  if (hashError) {
    await releaseNewReservation("Falló el registro de preparación local");
    return failure(409, hashError.message);
  }
  revalidatePath("/admin/events/" + id);

  const safeName = event.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "evento";
  return new Response(canonicalJson(pkg), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.yr-event-transfer+json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName}-preparacion.yrprep"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
