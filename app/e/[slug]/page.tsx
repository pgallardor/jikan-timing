import Link from "next/link";
import { notFound } from "next/navigation";
import PublicStandingTable from "@/components/public-standing-table";
import PublicRefresh from "@/components/public-refresh";
import { createClient } from "@supabase/supabase-js";

type PublicStandingRow = {
  event_name: string;
  event_slug: string;
  event_status: string;
  event_timezone: string;
  participant_exists: boolean;
  participant_name: string | null;
  bib: string | null;
  category: string | null;
  distance: string | null;
  sex: string | null;
  result_status: string | null;
  start_at: string | null;
  finish_at: string | null;
  elapsed_seconds: number | null;
  overall_place: number | null;
  category_place: number | null;
};

const statusLabels: Record<string, string> = {
  draft: "Borrador",
  open: "En curso",
  closed: "Cerrado",
  published: "Publicado",
};

export default async function PublicStandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) notFound();

  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.rpc("get_public_event_standing", { p_event_slug: slug });
  const rows = (data ?? []) as PublicStandingRow[];
  if (error || rows.length === 0 || rows[0].event_slug !== slug) notFound();

  const event = rows[0];
  const participants = rows.filter((row) => row.participant_exists);

  return <main className="public-shell standing-shell">
    <Link href="/" className="brand"><span className="brand-mark">T</span> Resultados Ticketnexo</Link>
    <article className="standing-card">
      <div className="standing-heading">
        <div>
          <p className="eyebrow">STANDING PÚBLICO · {event.event_slug}</p>
          <h1>{event.event_name}</h1>
          <p className="public-subtitle">Resultados del evento · consulta sin cuenta</p>
        </div>
        <div className="standing-live">
          <span className={"status-pill status-" + event.event_status}><i />{statusLabels[event.event_status] ?? event.event_status}</span>
          <PublicRefresh />
        </div>
      </div>

      <PublicStandingTable participants={participants} />
    </article>
    <p className="public-footer">RESULTADOS TICKETNEXO · RESULTADOS DE CARRERA</p>
  </main>;
}
