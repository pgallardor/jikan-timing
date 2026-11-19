import { bearerToken, createBearerClient } from "@/lib/supabase/bearer";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) return Response.json({ error: "La plataforma no tiene configurado su destino de ingestión." }, { status: 503 });
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "Inicia sesión como operador." }, { status: 401 });
  const supabase = createBearerClient(token);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return Response.json({ error: "La sesión de operador venció." }, { status: 401 });
  const { data, error } = await supabase.from("events")
    .select("id,name,status,event_date,start_at,timezone")
    .in("status", ["draft", "open", "published"])
    .order("event_date", { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) return Response.json({ error: "No se pudieron cargar los eventos del operador." }, { status: 503 });
  return Response.json({
    events: data ?? [],
    ingest_endpoint: `${supabaseUrl}/functions/v1/ingest`,
    publishable_key: publishableKey,
  }, { headers: { "Cache-Control": "no-store" } });
}
