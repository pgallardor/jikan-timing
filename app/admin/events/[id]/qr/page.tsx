import Link from "next/link";
import { notFound } from "next/navigation";
import PrintButton from "@/components/print-button";
import QrPrintGrid from "@/components/qr-print-grid";
import { participantDisplayName } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export default async function QrPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const [{ data: event }, { data: participants }] = await Promise.all([
    supabase.from("events").select("id,name,slug").eq("id", id).maybeSingle(),
    supabase.from("event_results").select("participant_id,bib,first_name,last_name,category,public_token").eq("event_id", id).order("bib", { ascending: true, nullsFirst: false }).range(0, 4999),
  ]);
  if (!event) notFound();
  const qrPeople = (participants ?? []).map((person) => ({
    path: "/e/" + event.slug + "/p/" + person.public_token,
    bib: person.bib,
    category: person.category,
    displayName: participantDisplayName(person.first_name, person.last_name),
  }));
  return <>
    <Link className="back-link" href={"/admin/events/" + id}>← Volver al evento</Link>
    <div className="page-heading">
      <div><p className="eyebrow">CONSULTA DE CORREDOR · {event.slug}</p><h1>Códigos QR<span className="heading-dot">.</span></h1><p className="heading-copy">{event.name} · {qrPeople.length} enlaces individuales.</p></div>
      <div className="qr-top-actions"><PrintButton /></div>
    </div>
    {qrPeople.length ? <QrPrintGrid participants={qrPeople} /> : <div className="empty-state"><span className="empty-icon">QR</span><h3>Aún no hay participantes</h3><p>Primero carga la nómina para generar los enlaces.</p></div>}
  </>;
}
