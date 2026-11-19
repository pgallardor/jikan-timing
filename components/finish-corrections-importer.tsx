"use client";

import { useState, type FormEvent } from "react";
import { importFinishCorrectionsAction } from "@/app/actions";
import { parseElapsedMilliseconds, parseFinishCorrectionsCsv, type CsvFinishCorrection } from "@/lib/correction-csv";

type CorrectionParticipant = {
  bib: string | null;
  name: string;
  hasStart: boolean;
  hasFinish: boolean;
};

type PreviewRow = CsvFinishCorrection & {
  elapsedMilliseconds: number | null;
  participant: CorrectionParticipant | null;
  error: string | null;
};

function formatElapsed(milliseconds: number | null) {
  if (milliseconds === null) return "—";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const fraction = milliseconds % 1000;
  return String(hours).padStart(2, "0") + ":"
    + String(minutes).padStart(2, "0") + ":"
    + String(seconds).padStart(2, "0")
    + (fraction ? "." + String(fraction).padStart(3, "0").replace(/0+$/, "") : "");
}

export default function FinishCorrectionsImporter({
  eventId,
  participants,
}: {
  eventId: string;
  participants: CorrectionParticipant[];
}) {
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function previewFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("file");
    const file = input instanceof HTMLInputElement ? input.files?.[0] : null;
    setMessage("");
    setPreview(null);
    if (!file) {
      setMessage("Selecciona un CSV para revisar.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMessage("El archivo no puede superar 5 MB.");
      return;
    }

    setLoading(true);
    try {
      const rows = parseFinishCorrectionsCsv(await file.text());
      const participantByBib = new Map(participants.filter((person) => person.bib).map((person) => [person.bib!, person]));
      const seen = new Set<string>();
      setPreview(rows.map((row) => {
        const elapsedMilliseconds = parseElapsedMilliseconds(row.elapsedTime);
        const participant = participantByBib.get(row.bib) ?? null;
        let error: string | null = null;
        if (!row.bib) error = "Falta el dorsal.";
        else if (seen.has(row.bib)) error = "El archivo repite este dorsal.";
        else if (!participant) error = "El dorsal no existe en este evento.";
        else if (!participant.hasStart) error = "El corredor no tiene salida registrada.";
        else if (elapsedMilliseconds === null) error = "Tiempo inválido; usa HH:MM:SS o MM:SS.";
        if (row.bib) seen.add(row.bib);
        return { ...row, elapsedMilliseconds, participant, error };
      }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo leer el CSV.");
    } finally {
      setLoading(false);
    }
  }

  const validRows = preview?.filter((row) => !row.error && row.elapsedMilliseconds !== null) ?? [];
  const errorCount = preview?.filter((row) => row.error).length ?? 0;
  const payload = JSON.stringify(validRows.map((row) => ({
    bib: row.bib,
    elapsed_milliseconds: row.elapsedMilliseconds,
    csv_row: row.rowNumber,
  })));

  return <div className="correction-importer">
    <form className="import-row correction-file-form" onSubmit={previewFile}>
      <label htmlFor={"correction-csv-" + eventId}>CSV de rectificaciones</label>
      <input className="file-input" id={"correction-csv-" + eventId} name="file" type="file" accept=".csv,text/csv" required onChange={() => { setPreview(null); setMessage(""); }} />
      <button className="button button-quiet button-small" disabled={loading}>{loading ? "Leyendo CSV…" : "Revisar archivo"}</button>
      <a className="download-link" href="/rectificaciones-plantilla.csv" download>Descargar plantilla</a>
    </form>
    {message && <p className="notice error" role="alert">{message}</p>}
    <p className="setting-caption">Formato: dorsal y tiempo_transcurrido. Admite HH:MM:SS o MM:SS, con hasta milésimas. La llegada se calcula sumando el tiempo a la salida registrada.</p>

    {preview && <>
      <p className={errorCount ? "correction-preview-summary has-errors" : "correction-preview-summary"}>
        {validRows.length} filas listas para cargar{errorCount ? " · " + errorCount + " con errores" : ""}.
        {errorCount ? " Corrige el archivo y vuelve a revisarlo para continuar." : ""}
      </p>
      <div className="table-wrap correction-preview-table">
        <table className="data-table"><thead><tr><th>Fila</th><th>Dorsal</th><th>Corredor</th><th>Tiempo transcurrido</th><th>Acción</th></tr></thead>
          <tbody>{preview.slice(0, 100).map((row) => <tr key={row.rowNumber} className={row.error ? "correction-row-error" : ""}>
            <td>{row.rowNumber}</td><td className="bib-cell">{row.bib || "—"}</td><td>{row.participant?.name ?? "—"}</td>
            <td>{row.elapsedMilliseconds === null ? row.elapsedTime || "—" : formatElapsed(row.elapsedMilliseconds)}</td>
            <td>{row.error || (row.participant?.hasFinish ? "Corregir llegada" : "Crear llegada")}</td>
          </tr>)}</tbody>
        </table>
        {preview.length > 100 && <p className="setting-caption">Vista previa de las primeras 100 de {preview.length} filas; todas las filas fueron validadas.</p>}
      </div>
      {errorCount === 0 && validRows.length > 0 && <form action={importFinishCorrectionsAction} className="correction-submit-form">
        <input type="hidden" name="event_id" value={eventId} />
        <input type="hidden" name="corrections" value={payload} />
        <label>Motivo para el historial<input name="reason" type="text" defaultValue="Rectificación de llegada por carga CSV" maxLength={200} minLength={3} required /></label>
        <button className="button button-dark button-small">Aplicar {validRows.length} rectificaciones</button>
      </form>}
    </>}
  </div>;
}
