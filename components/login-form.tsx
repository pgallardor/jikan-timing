"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginForm() {
  const router = useRouter();
  const allowSignUp = process.env.NEXT_PUBLIC_ALLOW_SIGNUP !== "false";
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setMessage(""); setBusy(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    try {
      const supabase = createClient();
      if (mode === "signup" && allowSignUp) {
        const { data, error: authError } = await supabase.auth.signUp({ email, password });
        if (authError) throw authError;
        if (!data.session) setMessage("Cuenta creada. Revisa tu correo para confirmarla y luego inicia sesión.");
        else { router.replace("/admin"); router.refresh(); }
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError) throw authError;
        router.replace("/admin"); router.refresh();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo completar el acceso.");
    } finally { setBusy(false); }
  }

  return <>
    {allowSignUp && <div className="auth-tabs" role="tablist" aria-label="Tipo de acceso">
      <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Iniciar sesión</button>
      <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>Crear cuenta</button>
    </div>}
    <form className="stack-form auth-form" onSubmit={submit}>
      <label>Correo electrónico<input name="email" type="email" autoComplete="email" placeholder="equipo@carrera.cl" required /></label>
      <label>Contraseña<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} placeholder="Al menos 8 caracteres" required /></label>
      {error && <p className="form-error">{error}</p>}{message && <p className="form-success">{message}</p>}
      <button className="button button-dark button-full" disabled={busy}>{busy ? "Un momento…" : mode === "login" ? "Entrar al panel" : "Crear cuenta"} <span aria-hidden="true">→</span></button>
    </form>
    <p className="auth-small">El panel es para la organización. Los participantes consultan resultados sin cuenta.</p>
  </>;
}
