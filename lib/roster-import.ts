import { ageGroupValue } from "./classification";
import { normalizeAgeBracket, normalizeDistance, normalizeParticipantSex, type ParticipantSex } from "@/lib/participant-category";
import * as XLSX from "xlsx";

export const ROSTER_FIELDS = [
  "participant_id", "bib", "chip", "first_name", "last_name", "sex", "rut",
  "distance", "age", "age_bracket", "category", "team",
] as const;

export type RosterField = (typeof ROSTER_FIELDS)[number];
export type RosterOperation = "add" | "update" | "unchanged" | "skip";
export type ImportIssue = { level: "error" | "warning"; message: string };
export type RosterParticipant = {
  participant_id: string | null;
  bib: string | null;
  chip: string | null;
  first_name: string;
  last_name: string | null;
  sex: ParticipantSex | null;
  rut: string | null;
  distance: string | null;
  age: number | null;
  age_bracket: string | null;
  category: string | null;
  team: string | null;
};
export type RosterImportRow = {
  source_row: number;
  source_sheet: string | null;
  source_values: string[];
  mapped_fields: RosterField[];
  expected_values?: Record<string, unknown>;
  participant: RosterParticipant;
  operation: RosterOperation;
  issues: ImportIssue[];
};
export type RosterCell = {
  value: string;
  formulaWithoutResult?: boolean;
  unsafeNumber?: boolean;
};
export type RosterGridRow = { sourceRow: number; cells: RosterCell[] };
export type RosterSheet = { name: string; rows: RosterGridRow[] };
export type RosterColumn = { index: number; name: string };
export type RosterMapping = Partial<Record<RosterField, number | null>>;

const aliases: Record<RosterField, string[]> = {
  participant_id: ["participantid", "idparticipante", "participanteid", "idcorredor"],
  bib: ["dorsal", "bib", "numero", "numerodorsal"],
  chip: ["chip", "epc", "chips", "identificador"],
  first_name: ["nombre", "nombres", "firstname", "name"],
  last_name: ["apellido", "apellidos", "lastname", "surname"],
  sex: ["sexo", "sex", "genero", "gender"],
  rut: ["rut", "run"],
  distance: ["distancia", "distance", "prueba", "race"],
  age: ["edad", "edadnumero", "edadanios", "age", "ageyears"],
  age_bracket: ["agebracket", "bracketedad", "rangodeedad", "rangoedad", "grupoedad", "categoriaedad", "catdeedad", "categoriaetaria"],
  category: ["categoria", "category"],
  team: ["equipo", "team", "club"],
};

function normalizeHeader(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function distanceFromTitle(value: string) {
  const match = value.trim().match(/\b(\d+(?:[.,]\d+)?)\s*(kms?|k)\b/i);
  if (!match || !/(corriendo|carrera|race|distancia)/i.test(value)) return null;
  return normalizeDistance(match[1] + match[2]);
}

function sectionTitleDistance(row: RosterGridRow) {
  const populatedCells = row.cells.filter((cell) => cell.value.trim());
  if (populatedCells.length !== 1) return null;
  const title = populatedCells[0].value;
  const distanceCount = [...title.matchAll(/\b\d+(?:[.,]\d+)?\s*(?:kms?|k)\b/gi)].length;
  return distanceCount === 1 ? distanceFromTitle(title) : null;
}

export function detectCsvDelimiter(text: string) {
  const sample = text.replace(/^\uFEFF/, "").split(/\r?\n/).slice(0, 10).join("\n");
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
  let quoted = false;
  for (let index = 0; index < sample.length; index += 1) {
    const char = sample[index];
    if (char === '"' && sample[index + 1] === '"' && quoted) index += 1;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] || ",";
}

export function parseRosterCsv(text: string, delimiter = detectCsvDelimiter(text)): RosterGridRow[] {
  const rows: RosterGridRow[] = [];
  let row: RosterCell[] = [];
  let cell = "";
  let quoted = false;
  let sourceRow = 1;
  const input = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted && char === '"' && input[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if ((char === "\n" || char === "\r") && quoted) {
      cell += char;
      if (char === "\r" && input[index + 1] === "\n") {
        cell += "\n";
        index += 1;
      }
      sourceRow += 1;
    } else if (char === delimiter && !quoted) {
      row.push({ value: cell });
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push({ value: cell });
      if (row.some((value) => value.value.trim())) rows.push({ sourceRow, cells: row });
      row = [];
      cell = "";
      sourceRow += 1;
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("El archivo CSV tiene comillas sin cerrar.");
  row.push({ value: cell });
  if (row.some((value) => value.value.trim())) rows.push({ sourceRow, cells: row });
  return rows;
}

export function parseRosterWorkbook(data: ArrayBuffer): RosterSheet[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(data, {
      type: "array",
      cellFormula: true,
      cellText: true,
      cellNF: true,
      sheetRows: 6001,
    });
  } catch {
    throw new Error("No se pudo abrir el XLSX. Comprueba que el archivo no esté dañado y vuelve a exportarlo.");
  }
  if (workbook.vbaraw) throw new Error("Los libros con macros no están admitidos. Guarda una copia como XLSX sin macros.");
  if (!workbook.SheetNames.length || workbook.SheetNames.length > 30) {
    throw new Error("El libro debe tener entre 1 y 30 hojas.");
  }

  let totalCells = 0;
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const ref = sheet?.["!ref"];
    if (!ref) return { name, rows: [] };
    const range = XLSX.utils.decode_range(ref);
    const rowCount = range.e.r - range.s.r + 1;
    const columnCount = range.e.c - range.s.c + 1;
    totalCells += rowCount * columnCount;
    if (rowCount > 6000 || columnCount > 100 || totalCells > 250_000) {
      throw new Error(`La hoja “${name}” excede el límite de 6000 filas, 100 columnas o 250 000 celdas.`);
    }
    const rows: RosterGridRow[] = [];
    for (let r = range.s.r; r <= range.e.r; r += 1) {
      const cells: RosterCell[] = [];
      let hasContent = false;
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        const rawValue: unknown = cell?.v;
        const value = cell?.w ?? (rawValue == null ? "" : String(rawValue));
        const rendered = String(value);
        if (rendered.trim() || cell?.f) hasContent = true;
        cells.push({
          value: rendered,
          formulaWithoutResult: Boolean(cell?.f) && (rawValue === undefined || rawValue === null || rawValue === ""),
          unsafeNumber: typeof rawValue === "number" && (
            !Number.isSafeInteger(rawValue)
            || !Number.isInteger(rawValue)
            || Boolean(cell?.z && !["General", "0"].includes(cell.z) && !/^0+$/.test(cell.z))
          ),
        });
      }
      if (hasContent) rows.push({ sourceRow: r + 1, cells });
    }
    return { name, rows };
  });
}

export function detectHeaderRow(rows: RosterGridRow[]) {
  const limit = Math.min(rows.length, 25);
  let bestIndex = -1;
  let bestScore = 0;
  for (let index = 0; index < limit; index += 1) {
    const names = rows[index].cells.map((cell) => normalizeHeader(cell.value));
    const score = ROSTER_FIELDS.reduce((total, field) => total + (names.some((name) => aliases[field].includes(name)) ? 1 : 0), 0);
    const hasName = names.some((name) => aliases.first_name.includes(name));
    if (hasName && score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestIndex;
}

export function inferRosterDistanceBeforeHeader(rows: RosterGridRow[], headerSourceRow: number) {
  const detected = rows
    .filter((row) => row.sourceRow < headerSourceRow)
    .map(sectionTitleDistance)
    .filter((distance): distance is string => Boolean(distance));
  const unique = [...new Set(detected)];
  return unique.length === 1 ? unique[0] : null;
}

export function detectRosterSectionTitleRows(rows: RosterGridRow[]) {
  return rows.filter((row) => sectionTitleDistance(row) !== null).map((row) => row.sourceRow);
}

export function buildColumns(header: RosterGridRow, dataRows: RosterGridRow[] = []) {
  const width = Math.max(header.cells.length, ...dataRows.map((row) => row.cells.length));
  return Array.from({ length: width }, (_, index) => ({
    index,
    name: header.cells[index]?.value.trim() || `Columna ${index + 1}`,
  }));
}

export function suggestRosterMapping(columns: RosterColumn[], dataRows: RosterGridRow[] = []): { mapping: RosterMapping; ambiguous: string[] } {
  const normalized = columns.map((column) => normalizeHeader(column.name));
  const mapping: RosterMapping = {};
  const ambiguous: string[] = [];
  const used = new Set<number>();
  for (const field of ROSTER_FIELDS) {
    const candidates = normalized.flatMap((name, index) => name !== "cat" && aliases[field].includes(name) ? [index] : []);
    if (candidates.length !== 1 || used.has(candidates[0])) continue;
    mapping[field] = candidates[0];
    used.add(candidates[0]);
  }
  columns.forEach((column, index) => {
    if (normalized[index] === "cat") ambiguous.push(`“${column.name}” puede ser categoría o grupo etario; asígnalo manualmente.`);
  });

  const ageColumnIndex = mapping.age;
  if (ageColumnIndex != null && mapping.age_bracket == null) {
    const ageColumn = columns[ageColumnIndex];
    const ageValues = dataRows
      .map((row) => row.cells[ageColumnIndex]?.value.trim() ?? "")
      .filter((value) => value && normalizeHeader(value) !== normalizeHeader(ageColumn.name));
    const bracketCount = ageValues.filter((value) => {
      const normalizedValue = normalizeHeader(value);
      return /\b\d{1,2}\s*(?:a|al|hasta|[-–—])\s*\d{1,2}\b/i.test(value)
        || /^(?:cat(?:egoria)?(?:extra|especial)|sinpremio|especial)$/.test(normalizedValue);
    }).length;
    const numericAgeCount = ageValues.filter((value) => /^\d{1,3}$/.test(value)).length;
    if (ageValues.length && numericAgeCount === 0 && bracketCount / ageValues.length >= 0.7) {
      mapping.age = null;
      mapping.age_bracket = ageColumnIndex;
    }
  }
  return { mapping, ambiguous };
}

function cellValue(row: RosterGridRow, index: number | null | undefined) {
  return index == null ? null : row.cells[index] ?? { value: "" };
}

function textValue(row: RosterGridRow, mapping: RosterMapping, field: RosterField) {
  const index = mapping[field];
  const cell = cellValue(row, index);
  const text = cell?.value.trim() ?? "";
  return { text, cell };
}

function lengthIssue(label: string, value: string, maximum: number, issues: ImportIssue[]) {
  if (value.length > maximum) issues.push({ level: "error", message: `${label} supera ${maximum} caracteres.` });
}

export function mergeUnmappedRosterFields(participant: RosterParticipant, existing: RosterParticipant, mappedFields: RosterField[]) {
  const merged = { ...participant };
  const mergedValues = merged as Record<string, unknown>;
  const existingValues = existing as Record<string, unknown>;
  const fields = new Set(mappedFields);
  for (const field of ["bib", "chip", "first_name", "last_name", "sex", "rut", "distance", "age", "age_bracket", "category", "team"] as const) {
    if (!fields.has(field)) mergedValues[field] = existingValues[field];
  }
  return { participant: merged, mappedFields: [...fields] };
}

export function normalizeRosterRows(
  rows: RosterGridRow[],
  columns: RosterColumn[],
  mapping: RosterMapping,
  defaultDistance: string,
  sheetName: string | null,
): RosterImportRow[] {
  const sourceHeaders = columns.map((column) => column.name);
  const firstNameIndex = mapping.first_name;
  if (firstNameIndex == null) throw new Error("Asigna una columna al campo Nombre para previsualizar la nómina.");
  const mappedFields = Object.entries(mapping).filter(([, index]) => index != null).map(([field]) => field);
  if (new Set(Object.entries(mapping).filter(([, index]) => index != null).map(([, index]) => index)).size !== mappedFields.length) {
    throw new Error("Una columna no puede asignarse a más de un campo. Resuelve el mapeo antes de continuar.");
  }

  let activeDistance = defaultDistance.trim() ? normalizeDistance(defaultDistance) : null;
  let sectionDistanceActive = false;
  const sectionTitleRows = new Set<number>();
  const normalizedRows: RosterImportRow[] = rows.map((row) => {
    const issues: ImportIssue[] = [];
    const raw = (field: RosterField) => textValue(row, mapping, field);
    const participantIdRaw = raw("participant_id");
    const bibRaw = raw("bib");
    const chipRaw = raw("chip");
    const firstNameRaw = raw("first_name");
    const lastNameRaw = raw("last_name");
    const sexRaw = raw("sex");
    const rutRaw = raw("rut");
    const distanceRaw = raw("distance");
    const ageRaw = raw("age");
    const ageBracketRaw = raw("age_bracket");
    const categoryRaw = raw("category");
    const teamRaw = raw("team");
    const extraCellValues = row.cells.slice(sourceHeaders.length).filter((cell) => cell.value.trim());
    if (extraCellValues.length) issues.push({ level: "error", message: "La fila contiene celdas con datos fuera de los encabezados. Agrega encabezados o corrige la fila." });
    const mappedIndexes = Object.entries(mapping).filter(([, index]) => index != null);
    const repeatedHeader = mappedIndexes.length >= 2 && mappedIndexes
      .filter(([field]) => field !== "participant_id")
      .every(([, index]) => normalizeHeader(row.cells[index!]?.value ?? "") === normalizeHeader(columns[index!]?.name ?? ""));
    if (repeatedHeader) {
      return {
        source_row: row.sourceRow,
        source_sheet: sheetName,
        source_values: row.cells.map((cell) => cell.value),
        mapped_fields: [],
        participant: { participant_id: null, bib: null, chip: null, first_name: "", last_name: null, sex: null, rut: null, distance: null, age: null, age_bracket: null, category: null, team: null },
        operation: "skip" as const,
        issues: [{ level: "warning" as const, message: "Se detectó y omitió un encabezado repetido dentro del archivo." }],
      };
    }
    const sectionDistance = sectionTitleDistance(row);
    if (sectionDistance) {
      sectionTitleRows.add(row.sourceRow);
      activeDistance = sectionDistance;
      sectionDistanceActive = true;
      return {
        source_row: row.sourceRow,
        source_sheet: sheetName,
        source_values: row.cells.map((cell) => cell.value),
        mapped_fields: [],
        participant: { participant_id: null, bib: null, chip: null, first_name: "", last_name: null, sex: null, rut: null, distance: activeDistance, age: null, age_bracket: null, category: null, team: null },
        operation: "skip" as const,
        issues: [{ level: "warning" as const, message: `Se detectó la sección ${activeDistance}; se asignará a sus filas hasta el siguiente encabezado de distancia.` }],
      };
    }
    const mappedValues = [participantIdRaw, bibRaw, chipRaw, firstNameRaw, lastNameRaw, sexRaw, rutRaw, distanceRaw, ageRaw, ageBracketRaw, categoryRaw, teamRaw];
    for (const { cell } of mappedValues) {
      if (cell?.formulaWithoutResult) issues.push({ level: "error", message: "Una celda asignada contiene una fórmula sin resultado guardado; expórtala o usa otra columna." });
    }

    const identityCells = [bibRaw, chipRaw, rutRaw];
    for (const { cell, text } of identityCells) {
      if (cell?.unsafeNumber || /\d(?:\.\d+)?e[+-]?\d+/i.test(text)) {
        issues.push({ level: "error", message: "Un identificador numérico es ambiguo o quedó expresado en notación científica. Corrige el archivo y vuelve a cargarlo." });
      }
    }

    const participantId = participantIdRaw.text || null;
    if (participantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(participantId)) {
      issues.push({ level: "error", message: "El ID estable del participante no es un UUID válido." });
    }
    const firstName = firstNameRaw.text;
    if (!firstName) issues.push({ level: "error", message: "Falta el nombre del participante." });
    const sex = sexRaw.text ? normalizeParticipantSex(sexRaw.text) : null;
    if (sexRaw.text && sex === "no_informado") {
      const normalized = sexRaw.text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!["nd", "na", "sindato", "sininformacion", "noinformado", "noespecificado", "noespecificada", "prefieronodecir", "prefieronoresponder", "nosabe", "unknown", "unspecified"].includes(normalized)) {
        issues.push({ level: "warning", message: `Sexo “${sexRaw.text}” no reconocido; se guardará como no informado.` });
      }
    }
    const rawDistance = distanceRaw.text || activeDistance || defaultDistance.trim();
    const distance = normalizeDistance(rawDistance);
    if (!distance) issues.push({ level: "warning", message: "No hay distancia asignada; se debe revisar antes de calcular resultados." });

    let age: number | null = null;
    if (ageRaw.text) {
      if (!/^\d{1,3}$/.test(ageRaw.text) || Number(ageRaw.text) > 120) {
        issues.push({ level: "error", message: "La edad numérica debe ser un entero entre 0 y 120." });
      } else {
        age = Number(ageRaw.text);
      }
    }

    const ageBracketText = ageBracketRaw.text;
    const ageBracket = ageBracketText ? ageGroupValue(ageBracketText) : null;
    if (ageBracketText && /^\d+$/.test(ageBracketText)) {
      issues.push({ level: "warning", message: "El valor numérico no se convirtió en grupo etario; usa la columna Edad si es una edad individual." });
    }
    if (ageBracketText && !ageBracket) issues.push({ level:"error", message:"Grupo etario inválido: revisa el rango o el código del grupo." });
    const categoryText = categoryRaw.text || null;
    if (categoryText && normalizeAgeBracket(categoryText) && !ageBracket) {
      issues.push({ level: "warning", message: "El valor de categoría parece un grupo etario. Confirma su destino en el mapeo." });
    }

    lengthIssue("Nombre", firstName, 100, issues);
    lengthIssue("Apellido", lastNameRaw.text, 100, issues);
    lengthIssue("Dorsal", bibRaw.text, 50, issues);
    lengthIssue("Chip", chipRaw.text, 128, issues);
    lengthIssue("RUT", rutRaw.text, 30, issues);
    lengthIssue("Distancia", rawDistance, 32, issues);
    lengthIssue("Grupo etario", ageBracketText, 100, issues);
    lengthIssue("Categoría", categoryText ?? "", 120, issues);
    lengthIssue("Equipo", teamRaw.text, 100, issues);

    const chip = chipRaw.text.replace(/\s/g, "").toUpperCase() || null;
    const bib = bibRaw.text || null;
    const participant: RosterParticipant = {
      participant_id: participantId,
      bib,
      chip,
      first_name: firstName,
      last_name: lastNameRaw.text || null,
      sex,
      rut: rutRaw.text || null,
      distance,
      age,
      age_bracket: ageBracket,
      category: categoryText, // Preserve imported text as provenance; it never determines a classification.
      team: teamRaw.text || null,
    };

    const sourceValues = row.cells.map((cell) => cell.value);
    return {
      source_row: row.sourceRow,
      source_sheet: sheetName,
      source_values: sourceValues,
      mapped_fields: [
        ...ROSTER_FIELDS.filter((field) => mapping[field] != null && field !== "participant_id"),
        ...(!mapping.distance && (defaultDistance.trim() || sectionDistanceActive) ? ["distance" as const] : []),
      ],
      participant,
      operation: issues.some((issue) => issue.level === "error") ? "skip" : participantId ? "update" : "add",
      issues,
    };
  });
  return normalizedRows.filter((row) => !sectionTitleRows.has(row.source_row));
}
