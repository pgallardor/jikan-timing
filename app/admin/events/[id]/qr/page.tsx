import Link from "next/link";
import { notFound } from "next/navigation";
import PrintButton from "@/components/print-button";
import EventQrCode from "@/components/event-qr-code";
import { createClient } from "@/lib/supabase/server";

export default async function QrPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: event } = await supabase.from("events").select("id,name,slug").eq("id", id).maybeSingle();
  if (!event) notFound();
  const eventPath = "/e/" + event.slug;
  return <>
    <Link className="back-link" href={"/admin/events/" + id}>← Volver al evento</Link>
    <div className="page-heading">
      <div><p className="eyebrow">CONSULTA PÚBLICA · {event.slug}</p><h1>QR del evento<span className="heading-dot">.</span></h1><p className="heading-copy">{event.name} · abre el standing público.</p></div>
      <div className="qr-top-actions"><PrintButton /></div>
    </div>
    <EventQrCode eventPath={eventPath} eventName={event.name} />
  </>;
}
