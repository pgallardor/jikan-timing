import Link from "next/link";
import { notFound } from "next/navigation";
import PublicRefresh from "@/components/public-refresh";
import { formatDateTime, formatDuration } from "@/lib/format";
import { createClient } from "@supabase/supabase-js";

type PublicResult = {
  event_name: string;
  event_slug: string;
  event_status: string;
  event_timezone: string;
  participant_name: string | null;
  bib: string | null;
  category: string | null;
  result_status: string;
  start_at: string | null;
  finish_at: string | null;
  elapsed_seconds: number | null;
  overall_place: number | null;
  category_place: number | null;
  distance: string | null;
  sex: string | null;
};

function sexLabel(value: string | null) {
  if (value === "F") return "Damas";
  if (value === "M") return "Varones";
  if (value === "otro") return "Otro";
  if (value === "no_informado") return "No informado";
  return "Sin sexo";
}

export default async function PublicResultPage({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) notFound();
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.rpc("get_public_result_by_token", { p_public_token: token }).maybeSingle();
  const result = data as PublicResult | null;
  if (error || !result || result.event_slug !== slug) notFound();

  return <main className="public-shell">
    <Link href="/" className="brand"><span className="brand-mark">T</span> Resultados Ticketnexo</Link>
    <article className="public-card">
      <p className="eyebrow">RESULTADO PERSONAL · {result.event_slug}</p>
      <h1>{result.participant_name || "Tu resultado"}</h1>
      <p className="public-subtitle">{result.event_name}{result.bib ? " · Dorsal " + result.bib : ""}{result.category ? " · " + result.category : ""}</p>
      <div className={"public-state" + (result.result_status === "DNF" ? " public-state-dnf" : "")}><span>ESTADO DE CARRERA</span><strong>{result.result_status}</strong></div>
      <div className="public-result-grid">
        <div className="public-result"><span>Tiempo</span><strong className="public-time">{formatDuration(result.elapsed_seconds)}</strong></div>
        <div className="public-result"><span>Puesto general · {[result.distance, sexLabel(result.sex)].filter(Boolean).join(" ")}</span><strong>{result.overall_place ?? "—"}</strong></div>
        <div className="public-result"><span>Puesto categoría</span><strong>{result.category_place ?? "—"}</strong></div>
        <div className="public-result"><span>Salida</span><strong>{formatDateTime(result.start_at, result.event_timezone)}</strong></div>
        <div className="public-result"><span>Llegada</span><strong>{formatDateTime(result.finish_at, result.event_timezone)}</strong></div>
        <div className="public-result"><span>Actualización</span><strong><PublicRefresh /></strong></div>
      </div>
      <p className="auth-small">Este enlace es de consulta. Para solicitar una corrección, contacta a la organización.</p>
      <Link className="public-standing-link" href={"/e/" + result.event_slug}>Ver standing completo <span aria-hidden="true">→</span></Link>
    </article>
    <p className="public-footer">RESULTADOS TICKETNEXO · RESULTADOS DE CARRERA</p>
  </main>;
}
