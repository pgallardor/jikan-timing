import { parseElapsedMilliseconds } from "./correction-csv";
import { localDateTimeToUtc } from "./format";

export type ManualFinishInput = { bib: string; mode: "elapsed" | "clock"; value: string; reason: string };
export type ManualFinishParticipant = { id: string; bib: string | null; name: string; startAt: string | null; finishAt: string | null; dnf: boolean };
export type PreparedManualFinish = {
  bib: string; participant_id: string; expected_start_at: string; expected_finish_at: string | null;
  captured_at: string; reason: string; row_number: number;
};

export function prepareManualFinishes(rows: ManualFinishInput[], participants: ManualFinishParticipant[], timeZone: string, commonReason: string) {
  if (rows.length < 1 || rows.length > 5000) throw new Error("Ingresa entre 1 y 5000 llegadas.");
  const byBib = new Map(participants.filter((p) => p.bib).map((p) => [p.bib!, p]));
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const bib = row.bib.trim();
    const participant = byBib.get(bib) ?? null;
    let error: string | null = null;
    let prepared: PreparedManualFinish | null = null;
    try {
      if (!bib) throw new Error("Falta el dorsal.");
      if (seen.has(bib)) throw new Error("Dorsal repetido en la planilla.");
      if (!participant) throw new Error("El dorsal no pertenece a este evento.");
      if (participant.dnf) throw new Error("Quita el DNF desde la nómina antes de ingresar una llegada.");
      if (!participant.startAt) throw new Error("El corredor no tiene salida registrada.");
      const reason = row.reason.trim() || commonReason.trim();
      if (reason.length < 3 || reason.length > 200) throw new Error("El motivo debe tener entre 3 y 200 caracteres.");
      let capturedAt: string;
      if (row.mode === "elapsed") {
        const elapsed = parseElapsedMilliseconds(row.value);
        if (elapsed === null) throw new Error("Tiempo inválido: usa HH:MM:SS o MM:SS, con hasta milésimas.");
        capturedAt = new Date(Date.parse(participant.startAt) + elapsed).toISOString();
      } else if (row.mode === "clock") {
        capturedAt = localDateTimeToUtc(row.value, timeZone);
      } else throw new Error("Selecciona tiempo transcurrido u hora de llegada.");
      if (Date.parse(capturedAt) <= Date.parse(participant.startAt)) throw new Error("La llegada debe ser posterior a la salida.");
      prepared = { bib, participant_id: participant.id, expected_start_at: participant.startAt, expected_finish_at: participant.finishAt, captured_at: capturedAt, reason, row_number: index + 1 };
    } catch (cause) { error = cause instanceof Error ? cause.message : "Fila inválida."; }
    if (bib) seen.add(bib);
    return { rowNumber: index + 1, participant, prepared, error };
  });
}

export function parsePastedFinishes(text: string, mode: ManualFinishInput["mode"]): ManualFinishInput[] {
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim());
  const rows = lines.map((line) => {
    const [bib = "", value = "", ...reason] = line.split(line.includes("\t") ? "\t" : ";");
    return { bib: bib.trim(), value: value.trim().replace(" ", "T"), mode, reason: reason.join("; ").trim() };
  });
  if (/^(dorsal|bib)$/i.test(rows[0]?.bib ?? "")) rows.shift();
  if (!rows.length || rows.length > 5000) throw new Error("Pega entre 1 y 5000 filas: dorsal, tiempo y motivo opcional, separados por tabulación o punto y coma.");
  return rows;
}
