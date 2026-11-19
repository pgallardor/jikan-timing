const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST" && request.method !== "GET") return json(405, { status: "invalid" });
  const isPreflight = request.method === "GET";
  if (!isPreflight && Number(request.headers.get("content-length") ?? "0") > 16_384) {
    return json(413, { status: "invalid" });
  }

  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  const publishableKey = request.headers.get("apikey")?.trim() ?? "";
  if (!bearer || !publishableKey) return json(401, { status: "unauthorized" });

  let payload: Record<string, unknown> = {};
  if (!isPreflight) {
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(400, { status: "invalid" });
      payload = parsed as Record<string, unknown>;
    } catch {
      return json(400, { status: "invalid" });
    }
  }
  const query = new URL(request.url).searchParams;
  const eventId = isPreflight ? query.get("event_id") : payload.event_id;
  const deviceId = isPreflight ? query.get("device_id") : payload.device_id;
  if (!isUuid(eventId) || !isUuid(deviceId)) return json(400, { status: "invalid" });

  const readingId = payload.reading_id;
  const stage = payload.stage;
  const epc = typeof payload.epc === "string" ? payload.epc.replace(/\s/g, "").toUpperCase() : "";
  const capturedAt = typeof payload.captured_at === "string" ? new Date(payload.captured_at) : null;
  const antenna = Number(payload.antenna);
  const rssi = Number(payload.rssi);
  const sequence = Number(payload.sequence);

  if (!isPreflight && (!isUuid(readingId) ||
      !["start", "finish"].includes(String(stage)) || !epc || epc.length > 128 ||
      typeof payload.captured_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(payload.captured_at) ||
      !capturedAt || Number.isNaN(capturedAt.valueOf()) ||
      !Number.isInteger(antenna) || antenna < 1 || antenna > 64 ||
      !Number.isInteger(rssi) || rssi < -128 || rssi > 0 ||
      !Number.isSafeInteger(sequence) || sequence < 0)) {
    return json(400, { status: "invalid" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json(500, { status: "unavailable" });

  const baseUrl = supabaseUrl.replace(/\/+$/, "");
  const authHeaders = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
  };

  try {
    const userResponse = await fetch(`${baseUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey, authorization: `Bearer ${bearer}` },
    });
    if (!userResponse.ok) return json(401, { status: "unauthorized" });
    const user = await userResponse.json();
    if (!user || typeof user.id !== "string" || !isUuid(user.id)) return json(401, { status: "unauthorized" });

    const eventUrl = new URL(`${baseUrl}/rest/v1/events`);
    eventUrl.searchParams.set("select", "id,owner_id,name,status,local_operation_status");
    eventUrl.searchParams.set("id", `eq.${eventId}`);
    const eventResponse = await fetch(eventUrl, {
      headers: { ...authHeaders, "accept-profile": "public" },
    });
    if (!eventResponse.ok) return json(503, { status: "unavailable" });
    const events = await eventResponse.json();
    const event = Array.isArray(events) ? events[0] : null;
    if (!event) return json(404, { status: "unavailable", reason: "event_not_found" });
    if (event.owner_id !== user.id) return json(401, { status: "unauthorized" });

    const localOperationActive = event.local_operation_status === "prepared" || event.local_operation_status === "active";
    const canReceive = event.status === "open" && !localOperationActive;
    const reason = canReceive ? null : localOperationActive ? "local_operation_active" : event.status === "draft" ? "event_draft" : "event_not_open";
    const message = canReceive
      ? `Recepción lista para “${event.name}”.`
      : localOperationActive
        ? `El evento “${event.name}” está reservado para una operación local. La recepción remota permanece bloqueada.`
        : `El evento “${event.name}” está ${event.status === "draft" ? "en Borrador" : event.status === "closed" ? "Cerrado" : event.status === "published" ? "Publicado" : "en un estado desconocido"}. Habilite la recepción desde administración.`;

    if (isPreflight) {
      return json(200, {
        status: canReceive ? "ready" : "blocked",
        api_version: 1,
        event_id: event.id,
        event_name: event.name,
        event_status: event.status,
        local_operation_status: event.local_operation_status,
        can_receive: canReceive,
        reason,
        message,
        checked_at: new Date().toISOString(),
      });
    }
    if (localOperationActive) {
      return json(200, { status: "event_closed", reason, message });
    }

    const deviceUrl = new URL(`${baseUrl}/rest/v1/reader_devices`);
    deviceUrl.searchParams.set("select", "id,event_id,is_active");
    deviceUrl.searchParams.set("id", `eq.${deviceId}`);
    const deviceResponse = await fetch(deviceUrl, {
      headers: { ...authHeaders, "accept-profile": "public" },
    });
    if (!deviceResponse.ok) return json(503, { status: "unavailable" });
    const devices = await deviceResponse.json();
    const device = Array.isArray(devices) ? devices[0] : null;

    if (device && device.event_id !== eventId) return json(401, { status: "unauthorized" });
    if (!device) {
      const internalCredentialHash = await sha256(crypto.randomUUID());
      const registerResponse = await fetch(`${baseUrl}/rest/v1/reader_devices`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "content-type": "application/json",
          "content-profile": "public",
          prefer: "return=minimal",
        },
        body: JSON.stringify({
          id: deviceId,
          event_id: eventId,
          name: `RFIDTiming ${deviceId}`,
          credential_hash: internalCredentialHash,
          is_active: true,
        }),
      });
      if (!registerResponse.ok) return json(503, { status: "unavailable" });
    } else if (!device.is_active) {
      const enableUrl = new URL(`${baseUrl}/rest/v1/reader_devices`);
      enableUrl.searchParams.set("id", `eq.${deviceId}`);
      enableUrl.searchParams.set("event_id", `eq.${eventId}`);
      const enableResponse = await fetch(enableUrl, {
        method: "PATCH",
        headers: { ...authHeaders, "content-type": "application/json", "content-profile": "public", prefer: "return=minimal" },
        body: JSON.stringify({ is_active: true }),
      });
      if (!enableResponse.ok) return json(503, { status: "unavailable" });
    }

    if (isPreflight) {
      try {
        const heartbeatUrl = new URL(`${baseUrl}/rest/v1/reader_devices`);
        heartbeatUrl.searchParams.set("id", `eq.${deviceId}`);
        heartbeatUrl.searchParams.set("event_id", `eq.${eventId}`);
        await fetch(heartbeatUrl, {
          method: "PATCH",
          headers: { ...authHeaders, "content-type": "application/json", "content-profile": "public", prefer: "return=minimal" },
          body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
        });
      } catch {
        // El preflight conserva su resultado aunque falle la actualización del contacto.
      }

      return json(200, {
        status: canReceive ? "ready" : "blocked",
        api_version: 1,
        event_id: event.id,
        event_name: event.name,
        event_status: event.status,
        local_operation_status: event.local_operation_status,
        can_receive: canReceive,
        reason,
        message,
        checked_at: new Date().toISOString(),
      });
    }

    const rpcResponse = await fetch(`${baseUrl}/rest/v1/rpc/ingest_rfid_reading`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": "application/json",
        "content-profile": "public",
      },
      body: JSON.stringify({
        p_event_id: eventId,
        p_device_id: deviceId,
        p_reading_id: readingId,
        p_stage: stage,
        p_epc: epc,
        p_captured_at: capturedAt.toISOString(),
        p_antenna: antenna,
        p_rssi: rssi,
        p_sequence_no: sequence,
      }),
    });
    if (!rpcResponse.ok) return json(503, { status: "unavailable" });
    const data = await rpcResponse.json();

    const heartbeatUrl = new URL(`${baseUrl}/rest/v1/reader_devices`);
    heartbeatUrl.searchParams.set("id", `eq.${deviceId}`);
    heartbeatUrl.searchParams.set("event_id", `eq.${eventId}`);
    try {
      await fetch(heartbeatUrl, {
        method: "PATCH",
        headers: {
          ...authHeaders,
          "content-type": "application/json",
          "content-profile": "public",
          prefer: "return=minimal",
        },
        body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
      });
    } catch {
      // A failed heartbeat must not invalidate an accepted reading.
    }

    const response = data && typeof data === "object" ? data as Record<string, unknown> : { status: "unavailable" };
    return json(response.status === "invalid" ? 400 : 200, response);
  } catch {
    return json(503, { status: "unavailable" });
  }
});
