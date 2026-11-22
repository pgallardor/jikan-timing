"use client";

import { useState } from "react";

type ApiResult = Record<string, unknown>;

export default function EventTransferUploader({
  targetEventId,
  targetEventName,
}: {
  targetEventId?: string;
  targetEventName?: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ApiResult | null>(null);
  const [receipt, setReceipt] = useState<ApiResult | null>(null);
  const [final, setFinal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send(mode: "preview" | "commit") {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.set("package", file);
      body.set("mode", mode);
      body.set("target_event_id", targetEventId ?? "");
      body.set("final", String(final));
      const response = await fetch("/api/admin/event-transfers", { method: "POST", body, cache: "no-store" });
      const payload = await response.json() as { result?: ApiResult; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error ?? "La web no confirmó la transferencia.");
      if (mode === "preview") {
        setPreview(payload.result);
        setReceipt(null);
      } else {
        const value = payload.result.receipt && typeof payload.result.receipt === "object"
          ? payload.result.receipt as ApiResult : payload.result;
        setReceipt(value);
        setPreview(null);
        const bytes = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(bytes);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = String(value.transfer_id ?? "publicacion") + ".yrreceipt";
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Error al procesar la transferencia.");
    } finally {
      setBusy(false);
    }
  }

  const eventName = String(preview?.event_name ?? "");
  const counts = preview?.counts && typeof preview.counts === "object" ? preview.counts as ApiResult : {};
  return <section className="panel d07-transfer-panel">
    <div className="panel-heading"><div><p className="eyebrow">D07 · SINCRONIZACIÓN</p><h2>Recibir revisión local</h2></div>
      <span className="muted">{targetEventName ? "Destino: " + targetEventName : "Publicación autónoma"}</span>
    </div>
    <div className="panel-body d07-transfer-body">
      <p className="setting-caption">
        Carga un paquete generado por RFID Local Race. La primera acción solo valida y muestra cambios; el segundo paso aplica la revisión completa en una transacción. Se conservan las identidades del destino y su enlace público.
      </p>
      <div className="d07-transfer-controls">
        <label className="ingest-recovery-file">Paquete .yrtransfer
          <input type="file" accept=".yrtransfer,.json,application/json" onChange={(event) => {
            setFile(event.target.files?.[0] ?? null); setPreview(null); setReceipt(null); setError("");
          }} />
        </label>
        <button className="button button-quiet button-small" disabled={!file || busy} onClick={() => void send("preview")}>
          {busy ? "Validando…" : "Previsualizar"}
        </button>
      </div>
      {!targetEventId && <p className="notice">La primera revisión crea un evento remoto con la identidad del paquete; las siguientes actualizan ese mismo evento. No vincula por nombre ni combina corredores automáticamente.</p>}
      {preview && <div className="d07-transfer-preview" role="status">
        <h3>Revisión validada · {eventName || targetEventName}</h3>
        <p>Revisión local {String(preview.local_revision ?? "—")} · destino remoto {String(preview.remote_revision ?? "nuevo")} · política {String(preview.policy_version ?? "—")}</p>
        <ul>
          <li>{String(counts.participants ?? 0)} participantes</li>
          <li>{String(counts.distances ?? 0)} distancias</li>
          <li>{String(counts.marks ?? 0)} marcas vigentes</li>
          <li>{String(counts.operations ?? 0)} operaciones de cronometraje</li>
          <li>{String(counts.receipts ?? 0)} recibos sanitizados (sin EPC)</li>
        </ul>
        {preview.duplicate === true && <p>Esta transferencia ya se aplicó. La confirmación anterior se recuperará sin volver a insertar datos.</p>}
        <label className="check-label d07-final-check"><input type="checkbox" checked={final} onChange={(event) => setFinal(event.target.checked)} />
          Confirmo publicar esta revisión como final{!final && " (si se deja desmarcado, quedará provisional)"}
        </label>
        <button className="button button-dark" disabled={busy} onClick={() => void send("commit")}>
          {busy ? "Aplicando revisión…" : final ? "Confirmar publicación final" : "Publicar revisión provisional"}
        </button>
      </div>}
      {receipt && <div className="notice d07-transfer-receipt" role="status">
        <strong>Recibida y verificada.</strong> {receipt.publication_state === "final" ? "Publicación final confirmada" : "Revisión provisional publicada"} · revisión remota {String(receipt.revision ?? "—")} · transferencia {String(receipt.transfer_id ?? "—")}.
        <p>Descargué el recibo .yrreceipt. Impórtalo en RFID Local Race para registrar la misma revisión y huella en su outbox.</p>
      </div>}
      {error && <p className="notice error" role="alert">{error}</p>}
    </div>
  </section>;
}
