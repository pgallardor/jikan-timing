import Link from "next/link";
import { notFound } from "next/navigation";
import PublicStandingTable from "@/components/public-standing-table";
import PublicRefresh from "@/components/public-refresh";
import { getCachedPublicEventStanding } from "@/lib/public-results";

const statusLabels: Record<string, string> = {
  draft: "Borrador",
  open: "En curso",
  closed: "Cerrado",
  published: "Publicado",
};

export default async function PublicStandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const rows = await getCachedPublicEventStanding(slug);
  if (rows.length === 0 || rows[0].event_slug !== slug) notFound();

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
          <PublicRefresh eventSlug={event.event_slug} />
        </div>
      </div>

      <PublicStandingTable participants={participants} />
    </article>
    <p className="public-footer">RESULTADOS TICKETNEXO · RESULTADOS DE CARRERA</p>
  </main>;
}
