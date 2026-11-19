import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let input: { email?: unknown; password?: unknown; refresh_token?: unknown };
  try { input = await request.json(); } catch { return Response.json({ error: "Solicitud de sesión inválida." }, { status: 400 }); }
  const supabase = await createClient();
  const refreshToken = typeof input.refresh_token === "string" ? input.refresh_token.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const result = refreshToken
    ? await supabase.auth.refreshSession({ refresh_token: refreshToken })
    : email && password
      ? await supabase.auth.signInWithPassword({ email, password })
      : { data: { session: null, user: null }, error: new Error("Ingresa email y contraseña.") };
  if (result.error || !result.data.session || !result.data.user) {
    return Response.json({ error: result.error?.message ?? "No se pudo iniciar sesión." }, {
      status: 401, headers: { "Cache-Control": "no-store" },
    });
  }
  const session = result.data.session;
  return Response.json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user: { id: result.data.user.id, email: result.data.user.email },
  }, { headers: { "Cache-Control": "no-store" } });
}
