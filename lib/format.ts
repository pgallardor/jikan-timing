export function slugify(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function formatDuration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
}

export function formatDateTime(value: string | null | undefined, timeZone = "America/Santiago") {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("es-CL", {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone,
    }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat("es-CL", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
  }
}

export function datetimeLocalValue(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "00";
  return part("year") + "-" + part("month") + "-" + part("day") + "T" + part("hour") + ":" + part("minute");
}

export function localDateTimeToUtc(value: string, timeZone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) throw new Error("Indica una fecha y hora válidas.");
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, seconds = 0] = timePart.split(":").map(Number);
  const second = Math.floor(seconds);
  const milliseconds = Math.round((seconds - second) * 1000);
  const assumedUtc = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
  const calendar = new Date(assumedUtc);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || seconds >= 60) {
    throw new Error("Indica una fecha y hora válidas.");
  }
  let result = assumedUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(result));
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
    const observedUtc = Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
      milliseconds,
    );
    result = assumedUtc - (observedUtc - result);
  }
  const converted = new Date(result);
  if (Number.isNaN(converted.valueOf())) throw new Error("Indica una fecha y hora válidas.");
  const roundTrip = new Intl.DateTimeFormat("sv-SE", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(converted).replace(" ", "T");
  if (roundTrip !== datePart + "T" + timePart.slice(0, 5) + ":" + String(second).padStart(2, "0")) {
    throw new Error("Esa hora no existe en la zona horaria del evento.");
  }
  return converted.toISOString();
}

export function participantDisplayName(firstName: string, lastName?: string | null) {
  return [firstName, lastName].filter(Boolean).join(" ");
}
