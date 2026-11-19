import Link from "next/link";
import LoginForm from "@/components/login-form";

export default function LoginPage() {
  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  return (
    <main className="auth-shell">
      <Link href="/" className="brand"><span className="brand-mark">T</span> Resultados Ticketnexo</Link>
      <section className="auth-card">
        <p className="eyebrow">PANEL DE ORGANIZACIÓN</p><h1>Tu carrera,<br /><em>en orden.</em></h1>
        {configured ? <LoginForm /> : <div className="alert alert-warn">Completa <code>.env.local</code> con las claves de Supabase local. Revisa el README.</div>}
        <p className="auth-footnote">Acceso local para organizadores y cronometristas.</p>
      </section>
      <p className="auth-bottom">RESULTADOS TICKETNEXO · SISTEMA DE CRONOMETRAJE</p>
    </main>
  );
}
