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

  const [{ data: event }, { data, error }] = await Promise.all([
    supabase.from("events").select("name").eq("id", id).maybeSingle(),
    supabase.from("event_participants")
      .select("id,bib,chip,first_name,last_name,sex,distance,age,age_bracket,category,team")
      .eq("event_id", id)
      .order("bib", { ascending: true, nullsFirst: false })
      .range(0, 4999),
  ]);
  if (!event) return new Response("Evento no encontrado", { status: 404 });
  if (error) return new Response("No se pudo exportar la nómina", { status: 500 });

  const header = ["participant_id", "dorsal", "chip", "nombre", "apellido", "sexo", "distancia", "edad", "bracket_edad", "categoria", "equipo"];
  const rows = (data ?? []).map((person) => [
    person.id, person.bib, person.chip, person.first_name, person.last_name,
    person.sex, person.distance, person.age, person.age_bracket, person.category, person.team,
  ]);
  const body = "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const filename = event.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase();
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename || "evento"}-nomina.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
