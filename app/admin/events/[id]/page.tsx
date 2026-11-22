import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addParticipantAction,
  markUnfinishedParticipantsAsDnfAction,
  recordDistanceStartManuallyAction,
  recordManualFinishByElapsedAction,
  recordManualEntryAction,
  releaseLocalOperationAction,
  reprocessIngestReceiptsAction,
  revokePublicQrAction,
  saveDistanceScheduleAction,
  startEventDistanceAction,
  updateEventStatusAction,
  updateEventDateAction,
  updateDistanceAwardPolicyAction,
  updatePublicFieldsAction,
  voidTimingEntryAction,
} from "@/app/actions";
import AdminEventTabs from "@/components/admin-event-tabs";
import AdminResultsTable from "@/components/admin-results-table";
import FinishCorrectionsImporter from "@/components/finish-corrections-importer";
import ParticipantPicker from "@/components/participant-picker";
import RosterImporter from "@/components/roster-importer";
import EventTransferUploader from "@/components/event-transfer-uploader";
import { createClient } from "@/lib/supabase/server";
import { datetimeLocalValue, formatDateTime, participantDisplayName } from "@/lib/format";

const statusLabels: Record<string, string> = { draft: "Borrador", open: "En curso", closed: "Cerrado", published: "Publicado", cancelled: "Cancelado" };
const stageLabels: Record<string, string> = { start: "Salida", finish: "Llegada" };
const actionLabels: Record<string, string> = {
  manual_created: "Marca manual añadida",
  manual_corrected: "Marca manual corregida",
  manual_voided: "Marca anulada",
  rfid_accepted: "Lectura RFID aceptada",
  rfid_ignored: "Lectura RFID no seleccionada",
  official_distance_start: "Salida oficial asignada a la distancia",
  dnf_marked: "Corredor marcado DNF",
};

type IngestIncident = {
  receipt_id: number;
  reading_id: string;
  device_name: string;
  status: string;
  reason: string | null;
  message: string | null;
  captured_at: string | null;
  stage: string | null;
  received_at: string;
  reprocessable: boolean;
  payload_available: boolean;
};

type IngestReprocessHistory = {
  reading_id: string;
  device_name: string;
  previous_status: string;
  result_status: string;
  reason: string;
  created_at: string;
};

type IngestHealth = {
  received: number;
  accepted: number;
  ignored: number;
  blocked: number;
  rejected: number;
  last_received_at: string | null;
  first_incident_at: string | null;
  last_incident_at: string | null;
  last_device_contact_at: string | null;
  recent: IngestIncident[];
  reprocess_history: IngestReprocessHistory[];
};

function elapsedTimeInput(startAt: string | null, finishAt: string | null) {
  if (!startAt || !finishAt) return "";
  const centiseconds = Math.round((Date.parse(finishAt) - Date.parse(startAt)) / 10);
  if (!Number.isFinite(centiseconds) || centiseconds <= 0) return "";
  const totalSeconds = Math.floor(centiseconds / 100);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const fraction = centiseconds % 100;
  return String(hours).padStart(2, "0") + ":"
    + String(minutes).padStart(2, "0") + ":"
    + String(seconds).padStart(2, "0")
    + (fraction ? "." + String(fraction).padStart(2, "0") : "");
}

function TimeCell({ value, origin, timeZone }: { value: string | null; origin: string | null; timeZone: string }) {
  return <div className="timing-cell">
    <time>{formatDateTime(value, timeZone)}</time>
    {origin && <small>{origin === "manual" ? "MANUAL" : "RFID"}</small>}
  </div>;
}

function EntryActions({
  eventId,
  participantId,
  stage,
  value,
  startAt,
  timeZone,
}: {
  eventId: string;
  participantId: string;
  stage: "start" | "finish";
  value: string | null;
  startAt: string | null;
  timeZone: string;
}) {
  const localValue = value ? datetimeLocalValue(new Date(value), timeZone) : datetimeLocalValue(new Date(), timeZone);
  const elapsedValue = elapsedTimeInput(startAt, value);
  return <div className="entry-actions">
    {stage === "finish" ? <form action={recordManualFinishByElapsedAction} className="row-actions">
      <input type="hidden" name="event_id" value={eventId} />
      <input type="hidden" name="participant_id" value={participantId} />
      <input className="reason-field" name="reason" minLength={3} placeholder="Motivo obligatorio" required aria-label="Motivo para llegada" />
      <input className="reason-field" name="elapsed_time" type="text" inputMode="text" placeholder="HH:MM:SS" defaultValue={elapsedValue} pattern="(?:[0-9]+:)?[0-5]?[0-9]:[0-5][0-9](?:[.,][0-9]{1,3})?" required aria-label="Tiempo transcurrido desde la salida" title="Usa HH:MM:SS o MM:SS" />
      <button>{value ? "Corregir" : "Registrar"}</button>
    </form> : <form action={recordManualEntryAction} className="row-actions">
      <input type="hidden" name="event_id" value={eventId} />
      <input type="hidden" name="participant_id" value={participantId} />
      <input type="hidden" name="stage" value="start" />
      <input className="reason-field" name="reason" minLength={3} placeholder="Motivo obligatorio" required aria-label="Motivo para salida" />
      <input className="reason-field" name="captured_at" type="datetime-local" defaultValue={localValue} required aria-label="Hora de salida" />
      <button>{value ? "Corregir" : "Registrar"}</button>
    </form>}
    {value && <form action={voidTimingEntryAction} className="row-actions">
      <input type="hidden" name="event_id" value={eventId} />
      <input type="hidden" name="participant_id" value={participantId} />
      <input type="hidden" name="stage" value={stage} />
      <input className="reason-field" name="reason" minLength={3} placeholder="Motivo para anular" required aria-label={"Motivo para anular " + stageLabels[stage]} />
      <button className="void-button">Anular</button>
    </form>}
  </div>;
}

export default async function EventPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const notice = await searchParams;
  const supabase = await createClient();
  const [{ data: event }, { data: results, error: resultsError }, { data: audit }, { data: distances }, { data: participantRoster, error: participantRosterError }, { data: rosterRevisions, error: rosterRevisionError }, { data: participantDistances }, { data: ingestHealthData, error: ingestHealthError }, { data: transferReceipts }, { data: localHistory }] = await Promise.all([
    supabase.from("events").select("*").eq("id", id).maybeSingle(),
    supabase.from("event_results").select("*").eq("event_id", id).order("bib", { ascending: true, nullsFirst: false }).range(0, 4999),
    supabase.from("timing_entry_audit").select("id,participant_id,stage,action,reason,created_at").eq("event_id", id).order("created_at", { ascending: false }).limit(30),
    supabase.from("event_distances").select("distance,official_start_at,started_at,exclude_general_top3_from_categories,award_policy_configured").eq("event_id", id).order("distance"),
    supabase.from("event_participants").select("id,bib,chip,first_name,last_name,sex,rut,distance,age,age_bracket,category,team,public_token").eq("event_id", id).order("bib", { ascending: true, nullsFirst: false }).range(0, 4999),
    supabase.from("event_roster_revisions").select("revision_no,source_name,added_count,updated_count,unchanged_count,skipped_count,issue_count,created_at").eq("event_id", id).order("revision_no", { ascending: false }).limit(10),
    supabase.from("event_participants").select("distance,category").eq("event_id", id).not("distance", "is", null),
    supabase.rpc("get_event_ingest_health", { p_event_id: id }),
    supabase.from("event_transfer_receipts").select("transfer_id,local_revision,payload_hash,publication_state,received_at,verified_at,published_at").eq("event_id", id).order("local_revision", { ascending: false }).limit(10),
    supabase.from("local_operation_history").select("operation_id,action,entity_id,occurred_at,details").eq("event_id", id).order("occurred_at", { ascending: false }).limit(100),
  ]);
  if (!event) notFound();
  const awardPoliciesReady = Boolean(distances?.length) && distances!.every((distance) => distance.award_policy_configured);
  const people = results ?? [];
  const completed = people.filter((person) => person.result_status === "FINALIZÓ");
  const onCourse = people.filter((person) => person.result_status === "EN CARRERA");
  const dnfCount = people.filter((person) => person.result_status === "DNF").length;
  const unmarkedWithoutFinish = people.filter((person) => !person.finish_at && person.result_status !== "DNF").length;
  const resultsByParticipantId = new Map(people.map((person) => [person.participant_id, person]));
  const rosterPeople = (participantRoster ?? []).map((person) => {
    const result = resultsByParticipantId.get(person.id);
    return {
      ...person,
      participant_id: person.id,
      start_at: result?.start_at ?? null,
      start_origin: result?.start_origin ?? null,
      finish_at: result?.finish_at ?? null,
      finish_origin: result?.finish_origin ?? null,
      result_status: result?.result_status ?? "SIN DATOS",
    };
  });
  const missingResultRows = rosterPeople.filter((person) => !resultsByParticipantId.has(person.participant_id)).length;
  const participantNames = new Map(rosterPeople.map((person) => [person.participant_id, participantDisplayName(person.first_name, person.last_name)]));
  const participantsByDistance = new Map<string, number>();
  const categoriesByDistance = new Map<string, Set<string>>();
  const startsByDistance = new Map<string, { count: number; times: Set<string> }>();
  for (const person of participantDistances ?? []) {
    participantsByDistance.set(person.distance, (participantsByDistance.get(person.distance) ?? 0) + 1);
    if (person.category) {
      const categories = categoriesByDistance.get(person.distance) ?? new Set<string>();
      categories.add(person.category);
      categoriesByDistance.set(person.distance, categories);
    }
  }
  for (const person of rosterPeople) {
    if (!person.distance || !person.start_at) continue;
    const starts = startsByDistance.get(person.distance) ?? { count: 0, times: new Set<string>() };
    starts.count += 1;
    starts.times.add(person.start_at);
    startsByDistance.set(person.distance, starts);
  }
  const qrHref = "/admin/events/" + id + "/qr";
  const nowLocal = datetimeLocalValue(new Date(), event.timezone);
  const ingestHealth = ingestHealthData as IngestHealth | null;
  const reprocessStartDefault = event.start_at
    ? datetimeLocalValue(new Date(event.start_at), event.timezone)
    : "";
  const arrivalParticipants = rosterPeople.map((person) => ({
    id: person.participant_id,
    bib: person.bib,
    name: participantDisplayName(person.first_name, person.last_name),
    category: person.category,
    chip: person.chip,
    hasStart: Boolean(person.start_at),
    hasFinish: Boolean(person.finish_at),
  }));

  return <>
    <Link className="back-link" href="/admin">← Todos los eventos</Link>
    <div className="event-title-row">
      <div><p className="eyebrow">EVENTO / {event.slug}</p><h1>{event.name}</h1>
        <div className="event-meta"><span>{event.organizer || "Organización sin nombre"}</span><span>{event.start_at ? formatDateTime(event.start_at, event.timezone) : event.event_date ?? "Fecha por definir"}</span><span>{event.timezone}</span></div>
      </div>
      <div className="heading-actions">
        <Link href={"/e/" + event.slug} className="button button-quiet button-small">Ver standing público</Link>
        <Link href={qrHref} className="button button-quiet button-small">Imprimir QRs</Link>
        <form action={updateEventStatusAction} className="heading-actions">
          <input type="hidden" name="event_id" value={id} />
          <select name="status" defaultValue={event.status} aria-label="Estado del evento" disabled={event.local_operation_status === "prepared" || event.local_operation_status === "active"}>
            {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button className="button button-dark button-small" disabled={event.local_operation_status === "prepared" || event.local_operation_status === "active"}>Guardar estado</button>
        </form>
      </div>
    </div>
    {(event.local_operation_status === "prepared" || event.local_operation_status === "active") && <p className="notice" role="status">
      <strong>Operación local preparada.</strong> La versión remota quedó bloqueada para cambios deportivos e ingestión RFID mientras la app local conserva la autoridad. Revisión remota confirmada: {event.local_published_revision ?? 0}; estado publicado: {event.local_publication_state ?? "ninguno"}.
    </p>}
    {event.status !== "open" && <p className="notice error" role="alert">
      <strong>{statusLabels[event.status] ?? event.status}:</strong> la recepción RFID remota está bloqueada. El lector recibirá un rechazo mientras el evento no esté En curso.
      {event.status === "draft" && " Cambiar el estado habilita la recepción; no registra la hora de salida de ninguna distancia."}
    </p>}
    <AdminEventTabs eventId={id} />
    {notice.ok && <p className="notice">{notice.ok}</p>}{notice.error && <p className="notice error">{notice.error}</p>}
    <div data-event-tab-panel="local" hidden>
    <section className="panel d07-transfer-panel">
      <div className="panel-heading"><div><p className="eyebrow">D07 · PREPARACIÓN OFFLINE</p><h2>Preparar operación local vinculada</h2></div>
        <span className="muted">{event.local_operation_status === "prepared" || event.local_operation_status === "active" ? "Reserva activa" : "Descarga autenticada"}</span>
      </div>
      <div className="panel-body d07-transfer-body">
        <p className="setting-caption">Descarga la definición, distancias, políticas compatibles, participantes e identidades QR. La preparación se valida antes de viajar y no activa recepción remota. El paquete excluye RUT, archivos fuente, recibos EPC y credenciales.</p>
        <form method="post" action={"/admin/events/" + id + "/preparation"}>
          <button className="button button-dark button-small">Descargar preparación .yrprep</button>
        </form>
        {event.local_operation_status === "prepared" || event.local_operation_status === "active"
          ? <p className="setting-caption">Esta operación ya está reservada. Repetir la descarga reutiliza el mismo ID de operación.</p>
          : <p className="setting-caption">Al descargar se bloquean nuevas escrituras remotas para evitar dos autoridades deportivas sobre el evento.</p>}
        {(event.local_operation_status === "prepared" || event.local_operation_status === "active") && <form action={releaseLocalOperationAction} className="d07-release-form">
          <input type="hidden" name="event_id" value={id} />
          <label>Motivo para liberar la reserva<input name="reason" minLength={5} maxLength={200} placeholder="Ej.: viaje cancelado y captura detenida" required /></label>
          {event.local_publication_state !== "final" && <label className="check-label"><input type="checkbox" name="confirm_unpublished" required /> Confirmo que no existe una publicación final que deba preservarse</label>}
          <button className="button button-quiet button-small">Liberar operación local</button>
        </form>}
      </div>
    </section>
    <EventTransferUploader targetEventId={id} targetEventName={event.name} />
    {(transferReceipts?.length || localHistory?.length) ? <section className="panel d07-transfer-panel">
      <div className="panel-heading"><div><p className="eyebrow">RECIBOS Y CONCILIACIÓN</p><h2>Revisiones locales recibidas</h2></div><span className="muted">Última revisión completa visible: {event.local_published_revision ?? 0}</span></div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Revisión</th><th>Estado</th><th>Transferencia</th><th>Huella</th><th>Recibida / verificada / publicada</th></tr></thead><tbody>
        {(transferReceipts ?? []).map((receipt) => <tr key={receipt.transfer_id}><td>{receipt.local_revision}</td><td>{receipt.publication_state === "final" ? "Final" : "Provisional"}</td>
          <td><code>{receipt.transfer_id}</code></td><td><code>{receipt.payload_hash.slice(0, 16)}…</code></td>
          <td>{formatDateTime(receipt.received_at, event.timezone)} / {formatDateTime(receipt.verified_at, event.timezone)} / {formatDateTime(receipt.published_at, event.timezone)}</td></tr>)}
      </tbody></table></div>
      {localHistory?.some((item) => item.action === "local_ingest_receipt") && <div className="panel-body">
        <h3>Recibos locales sanitizados</h3><p className="setting-caption">Se importan estado, motivo, etapa y hora; el EPC y el payload crudo permanecen en el equipo local.</p>
        <div className="audit-list">{localHistory.filter((item) => item.action === "local_ingest_receipt").slice(0, 30).map((item) => {
          const details = item.details as Record<string, unknown>;
          return <div className="audit-row" key={item.operation_id}><i className="audit-dot" /><div><p><strong>{String(details.status ?? "recibo")}</strong> · {String(details.stage ?? "sin etapa")} · {String(item.entity_id ?? "")}</p>
            <small>{formatDateTime(item.occurred_at, event.timezone)}{details.reason ? " · " + String(details.reason) : ""}</small></div></div>;
        })}</div>
      </div>}
    </section> : null}
    </div>

    <div data-event-tab-panel="results">
    <section className="metric-row">
      <div className="metric-card"><span>Corredores</span><strong>{rosterPeople.length}</strong></div>
      <div className="metric-card"><span>En carrera</span><strong>{onCourse.length}</strong></div>
      <div className="metric-card"><span>Finalizaron</span><strong>{completed.length}</strong></div>
      <div className="metric-card"><span>DNF</span><strong>{dnfCount}</strong></div>
    </section>

    <section className="panel" id="resultados">
      <div className="panel-heading panel-heading-dnf">
        <div><p className="eyebrow">CLASIFICACIÓN · SALIDA → LLEGADA</p><h2>Resultados del evento</h2></div>
        <div className="bulk-dnf-tools">
          <span className="muted">{completed.length} tiempos completos · {dnfCount} DNF</span>
          {unmarkedWithoutFinish > 0 ? <form action={markUnfinishedParticipantsAsDnfAction} className="bulk-dnf-form">
            <input type="hidden" name="event_id" value={id} />
            <label><input type="checkbox" name="confirm_dnf" required /> Confirmo marcar como DNF a los {unmarkedWithoutFinish} participantes sin llegada</label>
            <button className="button button-danger button-small">Marcar como DNF</button>
          </form> : <span className="muted">No hay participantes pendientes de marcar como DNF.</span>}
        </div>
      </div>
      <AdminResultsTable participants={completed} />
    </section>
    </div>

    <section className="panel ingest-health-panel" id="ingestion" data-event-tab-panel="reception" hidden>
      <div className="panel-heading"><div><p className="eyebrow">SALUD DE INGESTIÓN</p><h2>Conciliación de lectores</h2></div>
        <span className="muted">{ingestHealth?.last_device_contact_at ? "Último contacto " + formatDateTime(ingestHealth.last_device_contact_at, event.timezone) : "Sin contacto registrado"}</span>
      </div>
      {ingestHealthError ? <div className="panel-body"><p className="notice error">No se pudo consultar la salud de ingestión. Aplica la migración D04 para habilitar el panel.</p></div> : <>
        <div className="metric-row ingest-counts">
          <div className="metric-card"><span>Recibidas</span><strong>{ingestHealth?.received ?? 0}</strong></div>
          <div className="metric-card"><span>Aceptadas</span><strong>{ingestHealth?.accepted ?? 0}</strong></div>
          <div className="metric-card"><span>Ignoradas por política</span><strong>{ingestHealth?.ignored ?? 0}</strong></div>
          <div className="metric-card"><span>Bloqueadas</span><strong>{ingestHealth?.blocked ?? 0}</strong></div>
          <div className="metric-card"><span>Rechazadas</span><strong>{ingestHealth?.rejected ?? 0}</strong></div>
        </div>
        <p className="setting-caption" style={{ padding: "0 17px" }}>
          Último recibo: {ingestHealth?.last_received_at ? formatDateTime(ingestHealth.last_received_at, event.timezone) : "ninguno"}. El contacto del lector indica conectividad; no confirma aceptación deportiva.
        </p>
        {((ingestHealth?.blocked ?? 0) > 0 || (ingestHealth?.rejected ?? 0) > 0) &&
          <p className="notice error" role="status">
            {ingestHealth?.blocked ?? 0} bloqueadas y {ingestHealth?.rejected ?? 0} rechazadas requieren conciliación. Primer/último incidente recibido: {ingestHealth?.first_incident_at ? formatDateTime(ingestHealth.first_incident_at, event.timezone) : "—"} / {ingestHealth?.last_incident_at ? formatDateTime(ingestHealth.last_incident_at, event.timezone) : "—"}. Abre recepción, revisa el rango y reprocesa las lecturas autorizadas; recibos históricos sin payload requieren corrección manual auditada.
          </p>}
        <div className="panel-body">
          <h3>Incidentes recientes</h3>
          {ingestHealth?.recent?.length ? <>
            <form action={reprocessIngestReceiptsAction} className="ingest-reprocess-form">
              <input type="hidden" name="event_id" value={id} />
              <div className="ingest-window-fields">
                <label>Ventana autorizada desde<input name="window_start" type="datetime-local" defaultValue={reprocessStartDefault} required /></label>
                <label>Hasta<input name="window_end" type="datetime-local" defaultValue={nowLocal} required /></label>
                <label>Motivo de revisión<input name="reason" minLength={5} maxLength={200} placeholder="Ej.: recepción habilitada tras revisar horario" required /></label>
              </div>
              <label className="ingest-recovery-file">JSON del outbox local para recibos históricos sin payload
                <input name="recovery_payloads" type="file" accept="application/json,.json" multiple />
                <small>Si la lectura no tiene payload guardado en el servidor, selecciona su JSON desde %LOCALAPPDATA%\RFIDTiming\Outbox\&lt;evento&gt;\&lt;lector&gt;\Resolved.</small>
              </label>
              <div className="ingest-incident-list">
                {ingestHealth.recent.map((incident) => <label className="ingest-incident-row" key={incident.receipt_id}>
                  {incident.reprocessable && <input type="checkbox" name="receipt_id" value={incident.receipt_id} />}
                  <span className="ingest-incident-main">
                    <strong>{incident.status === "event_closed" ? "Bloqueada por estado" : incident.status === "unknown_chip" ? "Chip no encontrado" : incident.status}</strong>
                    <small>{incident.device_name} · {stageLabels[incident.stage ?? ""] ?? "Etapa desconocida"} · {incident.captured_at ? formatDateTime(incident.captured_at, event.timezone) : "Hora no disponible"}</small>
                    <small>ID {incident.reading_id} · recibida {formatDateTime(incident.received_at, event.timezone)}</small>
                    {incident.message && <small>{incident.message}</small>}
                    {incident.reprocessable && !incident.payload_available && <small>Recibo histórico sin payload en servidor. Adjunta el JSON local de esta lectura para recuperar el mismo ID y hora.</small>}
                    {!incident.reprocessable && <small>Este estado no admite reprocesamiento RFID; resuélvelo con una corrección manual auditada.</small>}
                  </span>
                </label>)}
              </div>
              <p className="setting-caption">El reprocesamiento requiere recepción abierta, mantiene el ID y la hora originales y registra el rechazo previo, el motivo y el resultado. Revisa la ventana antes de autorizarlo.</p>
              <button className="button button-dark button-small">Reprocesar seleccionadas</button>
            </form>
          </> : <p className="muted">No hay bloqueos ni rechazos recientes.</p>}
          {!!ingestHealth?.reprocess_history?.length && <div className="ingest-reprocess-history">
            <h3>Reprocesamientos auditados</h3>
            {ingestHealth.reprocess_history.map((item, index) => <p key={item.reading_id + item.created_at + index}>
              <strong>{item.previous_status} → {item.result_status}</strong> · {item.device_name} · {item.reason} · {formatDateTime(item.created_at, event.timezone)}
            </p>)}
          </div>}
        </div>
      </>}
    </section>

    <section className="panel" id="salidas" data-event-tab-panel="capture" hidden>
      <div className="panel-heading"><div><p className="eyebrow">HORA REAL DE LARGADA</p><h2>Salidas por distancia</h2></div><span className="muted">La hora real se aplica a todos los corredores de la distancia</span></div>
      <div className="panel-body distance-start-list">
        {distances?.length ? distances.map((distance) => {
          const startStats = startsByDistance.get(distance.distance) ?? { count: 0, times: new Set<string>() };
          const mustConfirm = Boolean(distance.started_at) || startStats.count > 0;
          const observedStart = startStats.times.size === 1 ? [...startStats.times][0] : null;
          const suggestedStart = distance.started_at ?? distance.official_start_at ?? observedStart;
          return <article className="distance-start-card" key={distance.distance}>
            <div className="distance-start-summary"><strong>{distance.distance}</strong><span>{participantsByDistance.get(distance.distance) ?? 0} corredores</span>
              {distance.started_at ? <small>Hora real · {formatDateTime(distance.started_at, event.timezone)}</small> : <small>{startStats.count ? startStats.count + " corredores con salida" : "Sin iniciar"}</small>}
              <small className="distance-category-list">Podios: {[...(categoriesByDistance.get(distance.distance) ?? [])].join(" / ") || "Sin categorías"}</small>
            </div>
            <div className="distance-start-forms">
              {!distance.started_at && startStats.count === 0 && <>
                <form action={saveDistanceScheduleAction} className="distance-schedule-form">
                  <input type="hidden" name="event_id" value={id} /><input type="hidden" name="distance" value={distance.distance} />
                  <label>Hora programada<input name="official_start_at" type="datetime-local" defaultValue={distance.official_start_at ? datetimeLocalValue(new Date(distance.official_start_at), event.timezone) : ""} /></label>
                  <button className="button button-quiet button-small">Guardar programación</button>
                </form>
                <form action={startEventDistanceAction} className="distance-start-now-form">
                  <input type="hidden" name="event_id" value={id} /><input type="hidden" name="distance" value={distance.distance} />
                  <button className="button button-dark button-small">{distance.official_start_at ? "Iniciar con hora programada" : "Iniciar ahora"}</button>
                </form>
              </>}
              <form action={recordDistanceStartManuallyAction} className="manual-start-form">
                <input type="hidden" name="event_id" value={id} /><input type="hidden" name="distance" value={distance.distance} />
                <label>Registrar hora real<input name="captured_at" type="datetime-local" defaultValue={suggestedStart ? datetimeLocalValue(new Date(suggestedStart), event.timezone) : nowLocal} required /></label>
                <label>Motivo<input name="reason" minLength={3} placeholder="Ej.: hora oficial confirmada" required /></label>
                {mustConfirm && <label className="confirm-replace"><input name="confirm_replace" type="checkbox" required />Confirmo aplicar esta hora a todos los {participantsByDistance.get(distance.distance) || 0} corredores{startStats.count > 0 ? " y reemplazar las " + startStats.count + " salidas existentes" : ""}</label>}
                <button className="button button-dark button-small">{mustConfirm ? "Corregir hora real" : "Registrar hora real"}</button>
              </form>
            </div>
          </article>;
        }) : <p className="muted">Las distancias aparecerán aquí al cargar participantes.</p>}
        <p className="setting-caption">La hora real asigna una misma salida a toda la distancia y queda en el historial. Si ya hay salidas, la corrección requiere confirmación y conserva los valores anteriores en auditoría.</p>
      </div>
    </section>

    <section className="panel" id="llegadas-manuales" data-event-tab-panel="capture" hidden>
      <div className="panel-heading"><div><p className="eyebrow">CORRECCIÓN DE LLEGADAS</p><h2>Registrar una llegada manual</h2></div><span className="muted">Para lecturas RFID perdidas o incorrectas</span></div>
      <div className="panel-body">
        <form action={recordManualFinishByElapsedAction} className="manual-entry-form">
          <input type="hidden" name="event_id" value={id} />
          <ParticipantPicker participants={arrivalParticipants} />
          <label>Tiempo transcurrido<input name="elapsed_time" type="text" placeholder="00:25:34" pattern="(?:[0-9]+:)?[0-5]?[0-9]:[0-5][0-9](?:[.,][0-9]{1,3})?" title="Usa HH:MM:SS o MM:SS" required /></label>
          <label>Motivo<input name="reason" minLength={3} placeholder="Ej.: error de lectura del lector" required /></label>
          <button className="button button-dark button-small" disabled={!rosterPeople.length}>Guardar llegada manual</button>
        </form>
        <p className="setting-caption">Ingresa el tiempo transcurrido desde la salida; el sistema calcula la hora de llegada automáticamente. Admite HH:MM:SS o MM:SS, opcionalmente con centésimas o milésimas. Si ya tenía llegada, conserva la marca anterior en el historial.</p>
        <div className="correction-import-block">
          <div><h3>Cargar rectificaciones desde CSV</h3><p>Previsualiza varias llegadas por dorsal y aplica el lote con un motivo común en el historial.</p></div>
          <FinishCorrectionsImporter eventId={id} participants={rosterPeople.map((person) => ({
            bib: person.bib,
            name: participantDisplayName(person.first_name, person.last_name),
            hasStart: Boolean(person.start_at),
            hasFinish: Boolean(person.finish_at),
          }))} />
        </div>
      </div>
    </section>

    <section className="panel" id="nomina" data-event-tab-panel="roster" hidden>
      <div className="panel-heading"><div><p className="eyebrow">NÓMINA DEL EVENTO</p><h2>Participantes y marcas</h2></div><span className="muted">{rosterPeople.length} participantes</span></div>
      <div className="panel-body">
        {awardPoliciesReady ? <form action={addParticipantAction} className="participant-form">
          <input type="hidden" name="event_id" value={id} />
          <label>Dorsal<input name="bib" placeholder="042" /></label><label>Chip / EPC<input name="chip" placeholder="9784" /></label><label>RUT (privado)<input name="rut" placeholder="Opcional" /></label>
          <label>Nombre<input name="first_name" placeholder="Camila" required /></label><label>Apellido<input name="last_name" placeholder="Soto" /></label>
          <label>Sexo<select name="sex" defaultValue=""><option value="">Sin informar</option><option value="F">Femenino</option><option value="M">Masculino</option><option value="otro">Otro</option></select></label>
          <label>Distancia<input name="distance" placeholder="3KM" /></label><label>Edad<input name="age" type="number" min="0" max="120" placeholder="Opcional" /></label><label>Grupo etario<input name="age_bracket" placeholder="4 a 8 años / Cat. especial" /></label><label>Equipo<input name="team" placeholder="Club" /></label>
          <button className="button button-dark">Añadir <span aria-hidden="true">+</span></button>
        </form> : <p className="notice">Configura la política de podios por distancia antes de ingresar corredores.</p>}
      </div>
      <div className="panel-body" style={{ paddingTop: 0 }}>
        {!awardPoliciesReady ? <p className="setting-caption">La carga de nómina se habilitará cuando cada distancia tenga una política confirmada.</p>
          : participantRosterError || rosterRevisionError
          ? <p className="notice error">No se pudo cargar la nómina y sus revisiones. Aplica la migración D02 de importación antes de usar el nuevo flujo.</p>
          : <RosterImporter
              eventId={id}
              participants={(participantRoster ?? []).map((person) => ({ ...person, participant_id: person.id }))}
              revisions={rosterRevisions ?? []}
              distances={(distances ?? []).map((distance) => distance.distance)}
            />}
      </div>
      {(resultsError || missingResultRows > 0) && <p className="notice" role="status" style={{ margin: "0 17px 16px" }}>
        La nómina se muestra desde los participantes guardados. No se pudieron cargar los datos de marcas para {resultsError ? "este evento" : `${missingResultRows} participante${missingResultRows === 1 ? "" : "s"}`}.
      </p>}
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Dorsal</th><th>Nombre</th><th>Apellidos</th><th>Chip</th><th>Edad</th><th>Categoría</th><th>Estado</th><th>Salida</th><th>Registrar / corregir salida</th><th>Llegada</th><th>Registrar / corregir llegada</th><th>QR</th></tr></thead><tbody>
        {participantRosterError
          ? <tr><td colSpan={12} className="muted">No se pudo leer la nómina del evento.</td></tr>
          : rosterPeople.length ? rosterPeople.map((person) => <tr key={person.participant_id}>
          <td className="bib-cell">{person.bib || "—"}</td>
          <td className="person-cell"><strong>{person.first_name}</strong><small>{person.team || person.sex || " "}</small></td><td>{person.last_name || "—"}</td>
          <td>{person.chip || <span className="muted">Sin chip</span>}</td><td>{person.age ?? "—"}</td><td>{person.category || "—"}</td>
          <td><span className={"result-tag " + (person.result_status === "FINALIZÓ" ? "result-finalizó" : person.result_status === "EN CARRERA" ? "result-en-carrera" : person.result_status === "DNF" ? "result-dnf" : "")}>{person.result_status}</span></td>
          <td><TimeCell value={person.start_at} origin={person.start_origin} timeZone={event.timezone} /></td>
          <td><EntryActions eventId={id} participantId={person.participant_id} stage="start" value={person.start_at} startAt={person.start_at} timeZone={event.timezone} /></td>
          <td><TimeCell value={person.finish_at} origin={person.finish_origin} timeZone={event.timezone} /></td>
          <td><EntryActions eventId={id} participantId={person.participant_id} stage="finish" value={person.finish_at} startAt={person.start_at} timeZone={event.timezone} /></td>
          <td><div className="row-actions">
            <Link className="qr-link" href={"/e/" + event.slug + "/p/" + person.public_token}>Abrir</Link>
            <form action={revokePublicQrAction}>
              <input type="hidden" name="event_id" value={id} /><input type="hidden" name="participant_id" value={person.participant_id} />
              <button className="void-button">Revocar</button>
            </form>
          </div></td>
        </tr>) : <tr><td colSpan={12} className="muted">Aún no hay corredores. Añade uno o carga la nómina en CSV o XLSX cuando esté lista.</td></tr>}
      </tbody></table></div>
    </section>

    <section className="settings-grid" id="configuracion" data-event-tab-panel="settings" hidden>
      <div className="panel"><div className="panel-heading"><div><p className="eyebrow">POLÍTICA DEL EVENTO</p><h2>Podios por distancia</h2></div></div>
        <div className="panel-body">
          <p className="setting-caption">Elige en cada distancia si los tres primeros de la general de cada sexo participan también en el podio etario. Cada categoría etaria entrega tres puestos.</p>
          {(distances ?? []).map((distance) => <form action={updateDistanceAwardPolicyAction} className="settings-form distance-policy-row" key={distance.distance}>
            <input type="hidden" name="event_id" value={id} /><input type="hidden" name="distance" value={distance.distance} />
            <label>{distance.distance}<select name="exclude_general_top3_from_categories" defaultValue={distance.exclude_general_top3_from_categories ? "true" : "false"} required disabled={event.local_operation_status === "prepared" || event.local_operation_status === "active"}>
              <option value="false">No excluir top 3</option><option value="true">Excluir top 3 general</option>
            </select></label>
            <button className="button button-quiet button-small" disabled={event.local_operation_status === "prepared" || event.local_operation_status === "active"}>Guardar</button>
            {!distance.award_policy_configured && <small>Requiere confirmación antes de importar.</small>}
          </form>)}
        </div>
      </div>
      <div className="panel"><div className="panel-heading"><div><p className="eyebrow">PREPARACIÓN OFFLINE</p><h2>Fecha de la carrera</h2></div></div>
        <div className="panel-body"><form action={updateEventDateAction} className="settings-form">
          <input type="hidden" name="event_id" value={id} />
          <label htmlFor="event-date">Fecha local</label>
          <input id="event-date" name="event_date" type="date" defaultValue={event.event_date ?? ""} required disabled={event.local_operation_status === "prepared" || event.local_operation_status === "active"} />
          <button className="button button-quiet button-small" disabled={event.local_operation_status === "prepared" || event.local_operation_status === "active"}>Guardar fecha</button>
          <p className="setting-caption">Se incluye en la preparación para que RFID Local Race conserve el día exacto aunque no haya una hora programada.</p>
        </form></div>
      </div>
      <div className="panel"><div className="panel-heading"><div><p className="eyebrow">PUBLICACIÓN · PRIVACIDAD</p><h2>Datos visibles públicamente</h2></div></div>
        <div className="panel-body"><form action={updatePublicFieldsAction} className="settings-form">
          <input type="hidden" name="event_id" value={id} />
          <label className="check-label"><input name="qr_show_name" type="checkbox" defaultChecked={event.qr_show_name} /> Nombre y apellidos</label>
          <label className="check-label"><input name="qr_show_bib" type="checkbox" defaultChecked={event.qr_show_bib} /> Dorsal</label>
          <label className="check-label"><input name="qr_show_category" type="checkbox" defaultChecked={event.qr_show_category} /> Categoría</label>
          <button className="button button-quiet button-small">Guardar</button>
          <p className="setting-caption">Se aplican al standing y al QR. Si se activa, se muestran nombre y apellidos; no se publican RUT, EPC ni correo.</p>
        </form></div>
      </div>
      <div className="panel"><div className="panel-heading"><div><p className="eyebrow">CAPTURA RFID</p><h2>Conexión del lector</h2></div></div>
        <div className="panel-body">
          <p className="setting-caption">Configura el umbral de señal y las antenas desde RFIDTiming. Al iniciar sesión con una cuenta que administra este evento, el lector queda autorizado para enviar resultados; no hace falta registrarlo en esta pantalla.</p>
        </div>
      </div>
      <div className="panel"><div className="panel-heading"><div><p className="eyebrow">PÁGINA DE CONSULTA</p><h2>Estado del evento</h2></div></div>
        <div className="panel-body"><span className={"status-pill status-" + event.status}><i />{statusLabels[event.status] ?? event.status}</span>
          <p className="setting-caption" style={{ marginTop: 12 }}>El standing y los QR son públicos desde el primer momento y se actualizan al registrar o corregir marcas. Este estado controla la captura RFID del evento.</p>
          <p className="setting-caption">Standing: <Link className="download-link" href={"/e/" + event.slug}>/e/{event.slug}</Link></p>
          <p className="setting-caption">QR individual: <code>/e/{event.slug}/p/&lt;token&gt;</code></p>
        </div>
      </div>
    </section>

    <section className="panel" id="historial" data-event-tab-panel="history" hidden>
      <div className="panel-heading"><div><p className="eyebrow">TRAZABILIDAD</p><h2>Historial reciente</h2></div><span className="muted">Últimas {audit?.length ?? 0} acciones</span></div>
      <div className="panel-body audit-list">
        {audit?.length ? audit.map((entry) => <div className="audit-row" key={entry.id}>
          <i className="audit-dot" /><div><p><strong>{actionLabels[entry.action] ?? entry.action}</strong> · {participantNames.get(entry.participant_id) ?? "Corredor"} · {stageLabels[entry.stage]}</p>
          <small>{formatDateTime(entry.created_at, event.timezone)}{entry.reason ? " · " + entry.reason : ""}</small></div>
        </div>) : <p className="muted">Las correcciones y marcas aceptadas quedarán registradas aquí.</p>}
      </div>
    </section>
  </>;
}
