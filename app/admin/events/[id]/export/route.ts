import { createClient } from "@/lib/supabase/server";

function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("No autorizado", { status: 401 });
  const { data: event } = await supabase.from("events").select("name").eq("id", id).maybeSingle();
  if (!event) return new Response("Evento no encontrado", { status: 404 });
  const { data, error } = await supabase.from("event_results").select("*").eq("event_id", id).order("bib").range(0, 4999);
  if (error) return new Response("No se pudo exportar el evento", { status: 500 });
  const header = ["participant_id", "dorsal", "chip", "nombre", "apellido", "sexo", "distancia", "bracket_edad", "categoria", "equipo", "estado", "salida_utc", "llegada_utc", "tiempo_segundos", "puesto_general", "puesto_categoria"];
  const rows = (data ?? []).map((person) => [
    person.participant_id, person.bib, person.chip, person.first_name, person.last_name, person.sex,
    person.distance, person.age_bracket, person.category, person.team, person.result_status,
    person.start_at, person.finish_at, person.elapsed_seconds,
    person.overall_place, person.category_place,
  ]);
  const body = "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const filename = event.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase();
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"" + (filename || "evento") + "-resultados.csv\"",
      "Cache-Control": "no-store",
    },
  });
}
