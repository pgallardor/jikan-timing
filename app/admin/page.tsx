import Link from "next/link";
import EventSetupForm from "@/components/event-setup-form";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/format";
import EventTransferUploader from "@/components/event-transfer-uploader";

const statusText: Record<string, string> = { draft: "Borrador", open: "En curso", closed: "Cerrado", published: "Publicado", cancelled: "Cancelado" };

export default async function AdminHome({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: events } = await supabase.from("events").select("id,name,slug,status,event_date,start_at,timezone,created_at").order("created_at", { ascending: false });
  return <>
    <div className="page-heading">
      <div><p className="eyebrow">CENTRO DE CONTROL</p><h1>Tus eventos<span className="heading-dot">.</span></h1><p className="heading-copy">Cada carrera vive por separado, con su propia nómina y cronología.</p></div>
      <span className="heading-count">{String(events?.length ?? 0).padStart(2, "0")} EVENTOS</span>
    </div>
    {params.error && <div className="alert alert-error">{params.error}</div>}
    <div className="event-layout">
      <section className="event-list">
        <div className="section-header"><div><p className="eyebrow">TEMPORADA LOCAL</p><h2>Eventos recientes</h2></div><span className="muted">{events?.length ?? 0} registrados</span></div>
        {events?.length
          ? <div className="event-cards">{events.map((event, index) => <Link className="event-card" href={"/admin/events/" + event.id} key={event.id}>
              <span className="event-card-index">{String(index + 1).padStart(2, "0")}</span>
              <div className="event-card-content"><span className={"status-pill status-" + event.status}><i />{statusText[event.status] ?? event.status}</span><h3>{event.name}</h3><p>{event.start_at ? formatDateTime(event.start_at, event.timezone) : event.event_date ?? "Fecha por definir"}<span className="event-slug">/{event.slug}</span></p></div>
              <span className="event-arrow" aria-hidden="true">↗</span>
            </Link>)}</div>
          : <div className="empty-state"><span className="empty-icon">01</span><h3>Tu primera carrera empieza aquí</h3><p>Crea un evento y luego carga la nómina cuando la tengas lista.</p></div>}
      </section>
      <aside className="create-card">
        <p className="eyebrow">NUEVO EVENTO</p><h2>Empieza<br />con una carrera.</h2><p className="muted">Configura los datos iniciales. Podrás ajustar el resto cuando confirmes la nómina.</p>
        <EventSetupForm />
      </aside>
    </div>
    <EventTransferUploader />
  </>;
}
