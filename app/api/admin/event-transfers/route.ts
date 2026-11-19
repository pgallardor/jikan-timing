import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { bearerToken, createBearerClient } from "@/lib/supabase/bearer";
import { D07_MAX_BYTES, parseTransferPackage } from "@/lib/d07-transfer";

export const runtime = "nodejs";

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const token = bearerToken(request);
  if (!token && (!origin || origin !== new URL(request.url).origin)) return json(403, { error: "Origen de solicitud no válido." });
  if (Number(request.headers.get("content-length") ?? "0") > D07_MAX_BYTES + 65_536) {
    return json(413, { error: "El paquete supera 32 MB." });
  }

  const supabase = token ? createBearerClient(token) : await createClient();
  const { data: { user }, error: authError } = token
    ? await supabase.auth.getUser(token)
    : await supabase.auth.getUser();
  if (authError || !user) return json(401, { error: "Inicia sesión para recibir una transferencia." });

  let packageText: string;
  let mode: string;
  let targetValue: string;
  let finalValue: unknown;
  try {
    const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.startsWith("application/vnd.yr-event-transfer+json")) {
      const url = new URL(request.url);
      packageText = await request.text();
      mode = url.searchParams.get("mode") ?? "";
      targetValue = url.searchParams.get("target_event_id") ?? "";
      finalValue = url.searchParams.get("final") === "true";
    } else if (contentType.startsWith("application/json")) {
      const input = await request.json() as Record<string, unknown>;
      packageText = typeof input.package === "string" ? input.package : JSON.stringify(input.package ?? null);
      mode = String(input.mode ?? "");
      targetValue = String(input.target_event_id ?? "").trim();
      finalValue = input.final;
    } else {
      const form = await request.formData();
      const upload = form.get("package");
      if (!(upload instanceof File) || upload.size === 0 || upload.size > D07_MAX_BYTES) {
        return json(400, { error: "Selecciona un archivo D07 válido de hasta 32 MB." });
      }
      packageText = await upload.text();
      mode = String(form.get("mode") ?? "");
      targetValue = String(form.get("target_event_id") ?? "").trim();
      finalValue = form.get("final");
    }
  } catch { return json(400, { error: "No se pudo leer el paquete de transferencia." }); }
  const targetEventId = targetValue || null;
  const finalPublication = finalValue === true || finalValue === "true";
  if (mode !== "preview" && mode !== "commit") return json(400, { error: "Acción de transferencia no válida." });
  if (targetEventId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetEventId)) {
    return json(400, { error: "La identidad del evento destino no es válida." });
  }

  try {
    if (new TextEncoder().encode(packageText).length > D07_MAX_BYTES) return json(413, { error: "El paquete supera 32 MB." });
    const pkg = parseTransferPackage(packageText);
    if (pkg.kind !== "publication") return json(400, { error: "La web recibe paquetes de publicación; la preparación se descarga desde el evento." });
    const { data, error } = await supabase.rpc("apply_event_transfer", {
      p_package: pkg,
      p_mode: mode,
      p_final: finalPublication,
      p_target_event_id: targetEventId,
    });
    if (error) {
      const status = error.code === "42501" ? 403 : error.code === "23505" || error.code === "40001" ? 409 : 422;
      return json(status, { error: error.message });
    }
    if (mode === "commit") {
      const result = data && typeof data === "object" && !Array.isArray(data)
        ? data as Record<string, unknown> : {};
      const eventId = String(result.event_id ?? targetEventId ?? "");
      if (eventId) {
        revalidatePath("/admin/events/" + eventId);
        revalidatePath("/e/" + String(result.event_slug ?? ""));
      }
      revalidatePath("/admin");
    }
    return json(200, { result: data });
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "No se pudo validar el paquete." });
  }
}
