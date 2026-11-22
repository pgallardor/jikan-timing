import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

type AvailableEvent = {
  name: string;
  slug: string;
  status: string;
  start_at: string | null;
  timezone: string;
};

const eventStatusLabels: Record<string, string> = {
  open: "En curso",
  closed: "Cerrado",
  published: "Publicado",
};

export default async function Home() {
  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  let events: AvailableEvent[] = [];
  let eventLoadFailed = false;

  if (configured) {
    try {
      const supabase = await createClient();
      const { data, error } = await supabase.rpc("get_public_available_events");
      if (error) eventLoadFailed = true;
      else events = (data ?? []) as AvailableEvent[];
    } catch {
      eventLoadFailed = true;
    }
  }

  return (
    <main className="landing">
      <div className="landing-grid" aria-hidden="true" />
      <header className="landing-header">
        <Link href="/" className="brand brand-light"><span className="brand-mark">T</span> Resultados Ticketnexo</Link>
        <Link className="button button-light button-small" href={configured ? "/login" : "#local-setup"}>
          {configured ? "Entrar" : "Configurar entorno"} <span aria-hidden="true">↗</span>
        </Link>
      </header>
      <section className="hero">
        <p className="eyebrow eyebrow-light"><span className="signal-dot" /> CRONOMETRAJE · RFID · RESULTADOS</p>
        <h1>Cada paso<br /><em>queda en tiempo.</em></h1>
        <p className="hero-copy">Una plataforma sencilla para organizar carreras, recibir lecturas RFID y compartir resultados claros con cada corredor.</p>
        <div className="hero-actions">
          <Link className="button button-primary" href={configured ? "/login" : "#local-setup"}>{configured ? "Abrir cronometraje" : "Preparar entorno local"} <span aria-hidden="true">→</span></Link>
          <span className="hero-note"><span className="signal-dot signal-green" /> CONSULTA PÚBLICA</span>
        </div>
        <div className="hero-stats">
          <div><strong>01</strong><span>Un evento,<br />una nómina</span></div>
          <div><strong>02</strong><span>Marcas con<br />historial auditable</span></div>
          <div><strong>03</strong><span>Un QR abre<br />cada evento</span></div>
        </div>
      </section>
      <aside className="hero-side" aria-label="Flujo de carrera">
        <div className="track-orbit orbit-one" /><div className="track-orbit orbit-two" />
        <div className="track-center"><span>START</span><b>01</b><span>FINISH</span></div>
        <div className="track-chip chip-one">RFID<br /><small>7C · 84A2</small></div>
        <div className="track-chip chip-two">00:42:18<br /><small>MARCA VÁLIDA</small></div>
        <div className="side-caption">CAPTURA · CLASIFICACIÓN · CONSULTA</div>
      </aside>
      {configured && <section className="public-events" aria-labelledby="public-events-title">
        <div className="public-events-heading">
          <div>
            <p className="eyebrow eyebrow-light">AGENDA DE CARRERAS</p>
            <h2 id="public-events-title">Eventos disponibles<span>.</span></h2>
            <p>Accede a carreras en curso y revisa los resultados de eventos finalizados.</p>
          </div>
          <span className="public-events-count">{eventLoadFailed ? "—" : String(events.length).padStart(2, "0")} DISPONIBLES</span>
        </div>
        {eventLoadFailed
          ? <div className="public-events-empty"><h3>No pudimos cargar los eventos</h3><p>Vuelve a intentarlo en unos momentos.</p></div>
          : events.length
            ? <div className="public-event-grid">{events.map((event, index) => <Link className="public-event-card" href={"/e/" + event.slug} key={event.slug}>
                <div className="public-event-card-top">
                  <span className={"status-pill status-" + event.status}><i />{eventStatusLabels[event.status] ?? event.status}</span>
                  <span className="public-event-index">EVENTO {String(index + 1).padStart(2, "0")}</span>
                </div>
                <h3>{event.name}</h3>
                <p className="public-event-date">{event.start_at ? formatDateTime(event.start_at, event.timezone) : "Fecha por confirmar"}</p>
                <span className="public-event-action">Ver resultados <b aria-hidden="true">↗</b></span>
              </Link>)}</div>
            : <div className="public-events-empty"><h3>Aún no hay eventos disponibles</h3><p>Cuando haya una carrera en curso o finalizada, aparecerá aquí.</p></div>}
      </section>}
      {!configured && <section id="local-setup" className="setup-note">
        <span className="setup-step">SIGUIENTE PASO</span><p>Inicia Supabase local y copia sus claves a <code>.env.local</code>. La guía de arranque está en el README de esta carpeta.</p>
      </section>}
      <footer className="landing-footer"><span>RESULTADOS TICKETNEXO / CRONOMETRAJE</span><span>DISEÑADO PARA CARRERAS REALES</span></footer>
    </main>
  );
}
