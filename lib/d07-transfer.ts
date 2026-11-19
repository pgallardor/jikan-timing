import { createHash } from "node:crypto";

export const D07_FORMAT = "yr-event-transfer";
export const D07_VERSION = 1;
export const D07_MAX_BYTES = 32 * 1024 * 1024;

export type TransferPackage = Record<string, unknown> & {
  format: string;
  version: number;
  kind: "preparation" | "publication";
  sha256: string;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

export function packageHash(value: Record<string, unknown>) {
  const unsigned = { ...value };
  delete unsigned.sha256;
  return createHash("sha256").update(canonicalJson(unsigned), "utf8").digest("hex");
}

function rejectPrivateFields(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(rejectPrivateFields);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    if (normalized === "epc" || normalized === "rut" || normalized.includes("credential") ||
        normalized.includes("service_role") || normalized === "source_file" || normalized === "source_payload") {
      throw new Error(`El paquete contiene un campo privado no permitido: ${key}.`);
    }
    rejectPrivateFields(item);
  }
}

export function parseTransferPackage(text: string): TransferPackage {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("El archivo no contiene JSON válido."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("El paquete debe ser un objeto JSON.");
  const pkg = value as Record<string, unknown>;
  if (pkg.format !== D07_FORMAT || pkg.version !== D07_VERSION || !["preparation", "publication"].includes(String(pkg.kind))) {
    throw new Error("El formato o la versión del paquete D07 no es compatible.");
  }
  if (typeof pkg.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(pkg.sha256) || packageHash(pkg) !== pkg.sha256) {
    throw new Error("La huella SHA-256 del paquete no coincide.");
  }
  rejectPrivateFields(pkg);
  if (!pkg.event || typeof pkg.event !== "object" || !pkg.manifest || typeof pkg.manifest !== "object") {
    throw new Error("El paquete no incluye manifiesto y definición del evento.");
  }
  if (pkg.kind === "publication") {
    const participants = (pkg as { participants?: unknown }).participants;
    if (!Array.isArray(participants) || participants.length < 1 || participants.length > 5000) {
      throw new Error("La publicación requiere entre 1 y 5000 participantes.");
    }
  }
  return pkg as TransferPackage;
}

export function formatLocalEventDate(eventDate: string | null, startAt: string | null, timezone: string) {
  if (eventDate && /^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return eventDate;
  if (!startAt) throw new Error("Completa la fecha del evento antes de descargar una preparación local.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(startAt));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
