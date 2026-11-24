import { ageGroupValue } from "./classification";
import { normalizeDistance, normalizeParticipantSex } from "@/lib/participant-category";

export type CsvParticipant = {
  bib: string | null;
  chip: string | null;
  first_name: string;
  last_name: string | null;
  sex: "F" | "M" | "otro" | "no_informado" | null;
  rut: string | null;
  distance: string | null;
  age_bracket: string | null;
  category: string | null;
  team: string | null;
};

function parseRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  const firstLine = input.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted && char === '"' && input[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("El archivo CSV tiene comillas sin cerrar.");
  row.push(cell.trim());
  if (row.some((value) => value.length)) rows.push(row);
  return rows;
}

function normalizeHeader(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const aliases: Record<string, string[]> = {
  bib: ["dorsal", "bib", "numero"],
  chip: ["chip", "epc", "chips"],
  first_name: ["nombre", "nombres", "firstname"],
  last_name: ["apellido", "apellidos", "lastname"],
  sex: ["sexo", "sex", "genero", "gender"],
  rut: ["rut", "run"],
  category: ["categoria", "category", "cat"],
  distance: ["distancia", "distance", "prueba", "race"],
  age_bracket: ["edad", "agebracket", "bracketedad", "rangodeedad", "rangoedad", "grupoedad", "categoriaedad", "catdeedad", "categoriaetaria", "cat"],
  team: ["equipo", "team", "club"],
};

function indexesFor(headers: string[]) {
  return Object.fromEntries(
    Object.entries(aliases).map(([field, names]) => [field, headers.findIndex((header) => names.includes(header))]),
  ) as Record<keyof typeof aliases, number>;
}

function distanceFromTitle(value: string): string | null {
  const title = value.trim();
  const distanceMatch = title.match(/\b(\d+(?:[.,]\d+)?)\s*(kms?|k)\b/i);
  const isRaceHeading = /corriendo|carrera|race/i.test(title);
  if (!distanceMatch || !isRaceHeading) return null;
  return normalizeDistance(distanceMatch[1] + distanceMatch[2]);
}

export function parseParticipantsCsv(text: string): CsvParticipant[] {
  const rows = parseRows(text);
  if (rows.length < 2) throw new Error("El CSV debe incluir encabezados y al menos una fila.");
  const participants: CsvParticipant[] = [];
  let activeHeaders: string[] | null = null;
  const titleDistance = distanceFromTitle(rows[0]?.[0] ?? "");

  for (const [rowIndex, row] of rows.entries()) {
    if (rowIndex === 0 && titleDistance) continue;
    const normalizedHeaders = row.map(normalizeHeader);
    const headerIndexes = indexesFor(normalizedHeaders);
    const isHeader = headerIndexes.first_name >= 0 && (headerIndexes.bib >= 0 || headerIndexes.chip >= 0 || headerIndexes.sex >= 0);
    if (isHeader) {
      activeHeaders = normalizedHeaders;
      continue;
    }

    if (!activeHeaders) continue;

    const indexes = indexesFor(activeHeaders);
    const value = (field: keyof typeof aliases) => (indexes[field] < 0 ? "" : (row[indexes[field]] ?? "").trim());
    const firstName = value("first_name");
    if (!firstName) {
      if (/^\d+$/.test(value("bib"))) throw new Error("Falta nombre en la fila " + (rowIndex + 1) + ".");
      continue;
    }

    const sex = normalizeParticipantSex(value("sex"));
    const rawAgeBracket = value("age_bracket");
    const ageBracket = ageGroupValue(rawAgeBracket);
    const rawDistance = value("distance") || titleDistance || "";
    const distance = normalizeDistance(rawDistance);
    participants.push({
      bib: value("bib") || null,
      chip: value("chip").replace(/\s/g, "").toUpperCase() || null,
      first_name: firstName,
      last_name: value("last_name") || null,
      sex,
      rut: value("rut") || null,
      distance,
      age_bracket: ageBracket,
      category: value("category") || null,
      team: value("team") || null,
    });
  }

  if (!participants.length) throw new Error("No se reconocieron encabezados con nombre y filas de participantes.");
  return participants;
}
