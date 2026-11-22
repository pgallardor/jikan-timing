"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { recordManualFinishesBatchAction } from "@/app/actions";
import { formatDateTime } from "@/lib/format";
import { parsePastedFinishes, prepareManualFinishes, type ManualFinishInput, type ManualFinishParticipant } from "@/lib/manual-finishes";

const blank = (): ManualFinishInput => ({ bib: "", mode: "elapsed", value: "", reason: "" });
function SubmitButton({ count, disabled }: { count: number; disabled: boolean }) {
  const { pending } = useFormStatus();
  return <button className="button button-dark button-small" disabled={disabled || pending}>{pending ? "Guardando lote…" : `Guardar ${count} llegadas`}</button>;
}

export default function ManualFinishesGrid({ eventId, participants, timeZone, disabled, savedToken }: {
  eventId: string; participants: ManualFinishParticipant[]; timeZone: string; disabled: boolean; savedToken: string | null;
}) {
  const [rows, setRows] = useState<ManualFinishInput[]>([blank()]);
  const [commonReason, setCommonReason] = useState("");
  const [paste, setPaste] = useState("");
  const [pasteMode, setPasteMode] = useState<ManualFinishInput["mode"]>("elapsed");
  const [reviewed, setReviewed] = useState(false);
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);
  const storageKey = "manual-finishes:" + eventId;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        if (savedToken && sessionStorage.getItem(storageKey + ":saved") !== savedToken) {
          sessionStorage.removeItem(storageKey);
          sessionStorage.setItem(storageKey + ":saved", savedToken);
          setRows([blank()]); setCommonReason(""); setReviewed(false);
        }
        else {
          const draft = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
          if (draft && Array.isArray(draft.rows) && draft.rows.length <= 5000 && draft.rows.every((r: ManualFinishInput) => r && typeof r.bib === "string" && typeof r.value === "string" && typeof r.reason === "string" && ["clock", "elapsed"].includes(r.mode))) {
            setRows(draft.rows); setCommonReason(typeof draft.reason === "string" ? draft.reason : "");
          }
        }
      } catch { /* The sheet also works when browser storage is unavailable. */ }
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [storageKey, savedToken]);
  useEffect(() => {
    if (ready) { try { sessionStorage.setItem(storageKey, JSON.stringify({ rows, reason: commonReason })); } catch { /* Quota exceeded. */ } }
  }, [storageKey, ready, rows, commonReason]);

  function update(index: number, patch: Partial<ManualFinishInput>) {
    setRows((current) => current.map((row, i) => i === index ? { ...row, ...patch } : row)); setReviewed(false);
  }
  const nonempty = rows.filter((row) => row.bib.trim() || row.value.trim() || row.reason.trim());
  const preview = nonempty.length ? prepareManualFinishes(nonempty, participants, timeZone, commonReason) : [];
  const errors = preview.filter((row) => row.error).length;
  const payload = JSON.stringify(preview.flatMap((row, index) => row.prepared ? [{
    input: nonempty[index], participant_id: row.prepared.participant_id,
    expected_start_at: row.prepared.expected_start_at, expected_finish_at: row.prepared.expected_finish_at,
  }] : []));
  return <div className="manual-finishes-grid">
    <h3>Planilla de llegadas manuales</h3>
    <p className="setting-caption">Ingresa varios dorsales sin crear un archivo. Cada fila permite tiempo transcurrido o fecha y hora de llegada en {timeZone}. Las llegadas existentes se corregirán con historial.</p>
    <fieldset disabled={disabled}>
      <label>Motivo común<input value={commonReason} maxLength={200} placeholder="Ej.: conciliación con planilla de llegada" onChange={(e) => { setCommonReason(e.target.value); setReviewed(false); }} /></label>
      <details className="manual-paste"><summary>Pegar filas desde Excel o una planilla</summary>
        <p className="setting-caption">Columnas: dorsal, tiempo y motivo opcional. Separadas por tabulación o punto y coma. Para hora de llegada: AAAA-MM-DD HH:MM:SS.</p>
        <label>Formato de las filas pegadas<select value={pasteMode} onChange={(e) => setPasteMode(e.target.value as ManualFinishInput["mode"])}><option value="elapsed">Tiempo transcurrido</option><option value="clock">Fecha y hora de llegada</option></select></label>
        <label>Filas<textarea rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"101\t00:32:10\n102\t00:33:45"} /></label>
        <button type="button" className="button button-quiet button-small" onClick={() => {
          try {
            const additions = parsePastedFinishes(paste, pasteMode);
            if (nonempty.length + additions.length > 5000) throw new Error("La planilla admite hasta 5000 filas.");
            setRows([...nonempty, ...additions]); setPaste(""); setReviewed(false); setMessage("");
          } catch (cause) { setMessage(cause instanceof Error ? cause.message : "No se pudieron pegar las filas."); }
        }}>Agregar filas pegadas</button>
      </details>
      {message && <p className="notice error" role="alert">{message}</p>}
      <div className="table-wrap"><table className="data-table manual-grid-table"><thead><tr><th>Fila</th><th>Dorsal</th><th>Formato</th><th>Tiempo / llegada</th><th>Motivo de la fila (opcional)</th><th>Acción</th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>
          <td>{index + 1}</td>
          <td><input aria-label={`Dorsal fila ${index + 1}`} value={row.bib} onChange={(e) => update(index, { bib: e.target.value })} /></td>
          <td><select aria-label={`Formato fila ${index + 1}`} value={row.mode} onChange={(e) => update(index, { mode: e.target.value as ManualFinishInput["mode"], value: "" })}><option value="elapsed">Tiempo transcurrido</option><option value="clock">Hora de llegada</option></select></td>
          <td><input aria-label={`Tiempo fila ${index + 1}`} type={row.mode === "clock" ? "datetime-local" : "text"} step={row.mode === "clock" ? "0.001" : undefined} placeholder="HH:MM:SS" value={row.value} onChange={(e) => update(index, { value: e.target.value })} /></td>
          <td><input aria-label={`Motivo fila ${index + 1}`} maxLength={200} value={row.reason} onChange={(e) => update(index, { reason: e.target.value })} /></td>
          <td><button type="button" className="button button-quiet button-small" onClick={() => { setRows(rows.length === 1 ? [blank()] : rows.filter((_, i) => i !== index)); setReviewed(false); }}>Quitar fila</button></td>
        </tr>)}</tbody></table></div>
      <div className="manual-grid-tools"><button type="button" className="button button-quiet button-small" disabled={rows.length >= 5000} onClick={() => { setRows([...rows, blank()]); setReviewed(false); }}>Añadir fila</button>
        <button type="button" className="button button-dark button-small" disabled={!nonempty.length} onClick={() => setReviewed(true)}>Revisar {nonempty.length} llegadas</button>
      </div>
    </fieldset>
    {reviewed && <div className="manual-grid-review" aria-live="polite">
      <p className={errors ? "notice error" : "notice"}>{preview.length - errors} filas válidas · {errors} con errores. {errors ? "Corrige todas las filas antes de guardar." : "Revisa las llegadas calculadas antes de confirmar."}</p>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Fila</th><th>Dorsal / corredor</th><th>Llegada anterior</th><th>Nueva llegada</th><th>Revisión</th></tr></thead><tbody>
        {preview.map((row, i) => <tr key={i}><td>{row.rowNumber}</td><td>{nonempty[i].bib} · {row.participant?.name ?? "—"}</td><td>{formatDateTime(row.participant?.finishAt, timeZone)}</td><td>{formatDateTime(row.prepared?.captured_at, timeZone)}{row.prepared && <small> · {row.prepared.captured_at.slice(20, 23)} ms</small>}</td><td>{row.error ?? (row.participant?.finishAt ? "Corregir llegada" : "Crear llegada")}</td></tr>)}
      </tbody></table></div>
      {!errors && preview.length > 0 && <form action={recordManualFinishesBatchAction} className="correction-submit-form">
        <input type="hidden" name="event_id" value={eventId} /><input type="hidden" name="rows" value={payload} /><input type="hidden" name="reason" value={commonReason} />
        <label className="check-label"><input type="checkbox" required />Confirmo guardar el lote completo y corregir las llegadas existentes indicadas arriba</label>
        <SubmitButton count={preview.length} disabled={disabled} />
      </form>}
    </div>}
  </div>;
}
