export type CsvFinishCorrection = {
  bib: string;
  elapsedTime: string;
  rowNumber: number;
};

function parseRows(text: string) {
  const input = text.replace(/^\uFEFF/, "");
  const firstLine = input.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
  const rows: { values: string[]; rowNumber: number }[] = [];
  let values: string[] = [];
  let cell = "";
  let quoted = false;
  let lineNumber = 1;
  let rowNumber = 1;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted && char === '"' && input[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      values.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      values.push(cell.trim());
      if (values.some((value) => value.length)) rows.push({ values, rowNumber });
      values = [];
      cell = "";
      lineNumber += 1;
      rowNumber = lineNumber;
    } else {
      cell += char;
      if (char === "\n") lineNumber += 1;
    }
  }
  if (quoted) throw new Error("El CSV tiene comillas sin cerrar.");
  values.push(cell.trim());
  if (values.some((value) => value.length)) rows.push({ values, rowNumber });
  return rows;
}

function normalizeHeader(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseFinishCorrectionsCsv(text: string): CsvFinishCorrection[] {
  const rows = parseRows(text);
  if (rows.length < 2) throw new Error("El CSV debe incluir encabezados y al menos una rectificación.");

  const headers = rows[0].values.map(normalizeHeader);
  const bibColumns = headers.flatMap((header, index) => ["dorsal", "bib", "numero"].includes(header) ? [index] : []);
  const elapsedColumns = headers.flatMap((header, index) => ["tiempotranscurrido", "elapsedtime", "elapsed"].includes(header) ? [index] : []);
  if (bibColumns.length !== 1 || elapsedColumns.length !== 1) {
    throw new Error("Se requieren las columnas únicas dorsal y tiempo_transcurrido.");
  }

  const [bibColumn] = bibColumns;
  const [elapsedColumn] = elapsedColumns;
  const corrections = rows.slice(1).map(({ values, rowNumber }) => ({
    bib: values[bibColumn]?.trim() ?? "",
    elapsedTime: values[elapsedColumn]?.trim() ?? "",
    rowNumber,
  }));
  if (!corrections.length) throw new Error("El CSV no contiene filas para importar.");
  if (corrections.length > 5000) throw new Error("La carga admite hasta 5000 rectificaciones.");
  return corrections;
}

export function parseElapsedMilliseconds(value: string): number | null {
  const input = value.trim();
  const fractionToMilliseconds = (fraction?: string) => Number((fraction ?? "").padEnd(3, "0"));
  const hoursFormat = input.match(/^(\d+):([0-5]\d):([0-5]\d)(?:[.,](\d{1,3}))?$/);
  const minutesFormat = input.match(/^(\d+):([0-5]\d)(?:[.,](\d{1,3}))?$/);
  let milliseconds: number;
  if (hoursFormat) {
    milliseconds = Number(hoursFormat[1]) * 3_600_000
      + Number(hoursFormat[2]) * 60_000
      + Number(hoursFormat[3]) * 1_000
      + fractionToMilliseconds(hoursFormat[4]);
  } else if (minutesFormat) {
    milliseconds = Number(minutesFormat[1]) * 60_000
      + Number(minutesFormat[2]) * 1_000
      + fractionToMilliseconds(minutesFormat[3]);
  } else {
    return null;
  }
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 31_536_000_000
    ? milliseconds
    : null;
}
