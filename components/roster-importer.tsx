"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { importRosterAction } from "@/app/actions";
import {
  buildColumns,
  detectCsvDelimiter,
  detectHeaderRow,
  detectRosterSectionTitleRows,
  inferRosterDistanceBeforeHeader,
  mergeUnmappedRosterFields,
  normalizeRosterRows,
  parseRosterCsv,
  parseRosterWorkbook,
  suggestRosterMapping,
  type RosterField,
  type RosterGridRow,
  type RosterImportRow,
  type RosterMapping,
  type RosterParticipant,
  type RosterSheet,
} from "@/lib/roster-import";
import { normalizeDistance } from "@/lib/participant-category";

type ExistingPerson = RosterParticipant & { participant_id: string };
type RevisionSummary = {
  revision_no: number;
  source_name: string;
  added_count: number;
  updated_count: number;
  unchanged_count: number;
  skipped_count: number;
  issue_count: number;
  created_at: string;
};
type PreviewRow = RosterImportRow & {
  matchTarget: string | null;
  corrections: Partial<Record<RosterField, string>>;
  skipConfirmed: boolean;
};
type Preset = { signature: string; mapping: RosterMapping };

const fieldLabels: Record<RosterField, string> = {
  participant_id: "ID estable",
  bib: "Dorsal",
  chip: "Chip / EPC",
  first_name: "Nombre (obligatorio)",
  last_name: "Apellido",
  sex: "Sexo",
  rut: "RUT (privado)",
  distance: "Distancia",
  age: "Edad numérica",
  age_bracket: "Grupo etario",
  category: "Categoría",
  team: "Equipo",
};

const fieldOrder: RosterField[] = [
  "participant_id", "bib", "chip", "first_name", "last_name", "sex", "distance",
  "age", "age_bracket", "category", "team", "rut",
];
const rosterPreviewFields: { field: RosterField; label: string }[] = [
  { field: "participant_id", label: "ID estable" },
  { field: "bib", label: "Dorsal" },
  { field: "chip", label: "Chip / EPC" },
  { field: "first_name", label: "Nombre" },
  { field: "last_name", label: "Apellido" },
  { field: "sex", label: "Sexo" },
  { field: "rut", label: "RUT" },
  { field: "distance", label: "Distancia" },
  { field: "age", label: "Edad" },
  { field: "age_bracket", label: "Grupo etario" },
  { field: "category", label: "Categoría" },
  { field: "team", label: "Equipo" },
];
const PAGE_SIZE = 25;

function participantIsEqual(left: RosterParticipant, right: ExistingPerson) {
  return ["bib", "chip", "first_name", "last_name", "sex", "rut", "distance", "age", "age_bracket", "category", "team"]
    .every((field) => left[field as keyof RosterParticipant] === right[field as keyof ExistingPerson]);
}

function presetKey(eventId: string) {
  return `roster-import-mapping:${eventId}`;
}

function sectionTitleNotice(labels: string[]) {
  if (!labels.length) return "";
  return `Se detectaron títulos de sección en ${labels.join(", ")}. Conviene quitarlos del archivo antes de importar; la vista previa y la carga los excluirán de la nómina.`;
}

export default function RosterImporter({
  eventId,
  participants,
  revisions,
  distances,
}: {
  eventId: string;
  participants: ExistingPerson[];
  revisions: RevisionSummary[];
  distances: string[];
}) {
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState<"utf-8" | "windows-1252">("utf-8");
  const [delimiter, setDelimiter] = useState(",");
  const [csvText, setCsvText] = useState("");
  const [sheets, setSheets] = useState<RosterSheet[]>([]);
  const [allSheets, setAllSheets] = useState(false);
  const [sheetName, setSheetName] = useState("");
  const [gridRows, setGridRows] = useState<RosterGridRow[]>([]);
  const [headerSourceRow, setHeaderSourceRow] = useState<number | null>(null);
  const [columns, setColumns] = useState<ReturnType<typeof buildColumns>>([]);
  const [mapping, setMapping] = useState<RosterMapping>({});
  const [defaultDistance, setDefaultDistance] = useState("");
  const inferredDefaultDistance = useRef(false);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [correctionsByRow, setCorrectionsByRow] = useState<Record<number, Partial<Record<RosterField, string>>>>({});
  const [unappliedCorrections, setUnappliedCorrections] = useState(false);
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [savedPreset, setSavedPreset] = useState<Preset | null>(null);
  const participantsById = useMemo(() => new Map(participants.map((participant) => [participant.participant_id, participant])), [participants]);
  const configuredDistanceKeys = useMemo(
    () => new Set(distances.map((distance) => normalizeDistance(distance)).filter((distance): distance is string => Boolean(distance))),
    [distances],
  );
  const previewBuilder = useRef<() => void>(() => undefined);

  const selectedHeader = gridRows.find((row) => row.sourceRow === headerSourceRow) ?? null;
  const headerOptions = gridRows.slice(0, 25);
  const actionableCount = previewRows.filter((row) => row.operation === "add" || row.operation === "update").length;
  const confirmableCount = actionableCount + previewRows.filter((row) => row.operation === "unchanged").length;
  const addedCount = previewRows.filter((row) => row.operation === "add").length;
  const updatedCount = previewRows.filter((row) => row.operation === "update").length;
  const unchangedCount = previewRows.filter((row) => row.operation === "unchanged").length;
  const skippedCount = previewRows.filter((row) => row.operation === "skip").length;
  const issueCount = previewRows.reduce((count, row) => count + row.issues.length, 0);
  const unresolvedErrorCount = previewRows.filter((row) => row.operation === "skip"
    && row.issues.some((issue) => issue.level === "error") && !row.skipConfirmed).length;
  const currentPageRows = useMemo(() => previewRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [previewRows, page]);
  const signature = columns.map((column) => column.name.trim().toLocaleLowerCase("es-CL")).join("\u001f");

  function updateInferredDistance(rows: RosterGridRow[], headerSourceRow: number | null) {
    const inferred = headerSourceRow == null ? null : inferRosterDistanceBeforeHeader(rows, headerSourceRow);
    if (inferredDefaultDistance.current || !defaultDistance.trim()) {
      inferredDefaultDistance.current = Boolean(inferred);
      setDefaultDistance(inferred ?? "");
    }
  }

  function activateGrid(rows: RosterGridRow[], activeSheet: string | null) {
    setPreviewRefreshKey((previous) => previous + 1);
    setGridRows(rows);
    setSheetName(activeSheet ?? "");
    const detected = detectHeaderRow(rows);
    const header = rows[detected >= 0 ? detected : 0] ?? null;
    setHeaderSourceRow(header?.sourceRow ?? null);
    updateInferredDistance(rows, header?.sourceRow ?? null);
    if (!header) {
      setColumns([]);
      setMapping({});
      setError("La hoja está vacía. Elige otra hoja o revisa el archivo.");
      return [] as string[];
    }
    const dataRows = rows.filter((row) => row.sourceRow > header.sourceRow);
    const nextColumns = buildColumns(header, dataRows);
    setColumns(nextColumns);
    const suggestion = suggestRosterMapping(nextColumns, dataRows);
    setMapping(suggestion.mapping);
    setPreviewRows([]);
    setCorrectionsByRow({});
    setUnappliedCorrections(false);
    setPage(0);
    setError("");
    const titleNotice = sectionTitleNotice(detectRosterSectionTitleRows(rows).map((sourceRow) => `fila ${sourceRow}`));
    setMessage([titleNotice, ...suggestion.ambiguous].filter(Boolean).join(" "));
    return suggestion.ambiguous;
  }

  function activateCsv(text: string, separator: string) {
    try {
      activateGrid(parseRosterCsv(text, separator), null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo leer el CSV.");
    }
  }

  async function readSelectedFile(selectedFile: File | null = file) {
    if (!selectedFile) {
      setError("Selecciona un archivo CSV o XLSX.");
      return;
    }
    const name = selectedFile.name.toLowerCase();
    if (name.endsWith(".csv")) {
      if (selectedFile.size > 5 * 1024 * 1024) {
        setError("El CSV supera el límite de 5 MB.");
        return;
      }
      try {
        const buffer = await selectedFile.arrayBuffer();
        let detectedEncoding = encoding;
        if (encoding === "utf-8" && new TextDecoder("utf-8").decode(buffer).includes("\uFFFD")) {
          detectedEncoding = "windows-1252";
          setEncoding(detectedEncoding);
        }
        const text = new TextDecoder(detectedEncoding).decode(buffer);
        const detected = detectCsvDelimiter(text);
        setCsvText(text);
        setDelimiter(detected);
        const rows = parseRosterCsv(text, detected);
        const ambiguities = activateGrid(rows, null);
        const encodingMessage = detectedEncoding === "windows-1252" ? "Codificación probable Windows-1252; puedes cambiarla." : "Codificación UTF-8.";
        const titleNotice = sectionTitleNotice(detectRosterSectionTitleRows(rows).map((sourceRow) => `fila ${sourceRow}`));
        setMessage([`CSV leído · ${encodingMessage} Delimitador ${detected === "\t" ? "tabulación" : detected === ";" ? "punto y coma" : "coma"}. Puedes corregirlo y revisar el mapeo.`, titleNotice, ...ambiguities].filter(Boolean).join(" "));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "No se pudo leer el CSV.");
      }
      return;
    }
    if (!name.endsWith(".xlsx")) {
      setError("Formato no admitido. Selecciona un archivo CSV o XLSX sin macros.");
      return;
    }
    if (selectedFile.size > 10 * 1024 * 1024) {
      setError("El XLSX supera el límite inicial de 10 MB comprimidos.");
      return;
    }
    try {
      const workbook = parseRosterWorkbook(await selectedFile.arrayBuffer());
      setSheets(workbook);
      setAllSheets(workbook.length > 1);
      const firstSheet = workbook[0];
      const ambiguities = activateGrid(firstSheet.rows, firstSheet.name);
      const titleLabels = workbook.flatMap((sheet) => detectRosterSectionTitleRows(sheet.rows)
        .map((sourceRow) => `${sheet.name}, fila ${sourceRow}`));
      setMessage([`Libro leído · ${workbook.length} hoja${workbook.length === 1 ? "" : "s"}. Selecciona la hoja que corresponde a esta importación.`, sectionTitleNotice(titleLabels), ...ambiguities].filter(Boolean).join(" "));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo abrir el XLSX.");
    }
  }

  function updateHeader(sourceRow: number) {
    setPreviewRefreshKey((previous) => previous + 1);
    setHeaderSourceRow(sourceRow);
    const header = gridRows.find((row) => row.sourceRow === sourceRow);
    if (!header) return;
    const dataRows = gridRows.filter((row) => row.sourceRow > sourceRow);
    updateInferredDistance(gridRows, sourceRow);
    const nextColumns = buildColumns(header, dataRows);
    setColumns(nextColumns);
    const suggestion = suggestRosterMapping(nextColumns, dataRows);
    setMapping(suggestion.mapping);
    setPreviewRows([]);
    setCorrectionsByRow({});
    setUnappliedCorrections(false);
    setPage(0);
    const titleNotice = sectionTitleNotice(detectRosterSectionTitleRows(gridRows).map((rowNumber) => `fila ${rowNumber}`));
    setMessage([titleNotice, ...suggestion.ambiguous].filter(Boolean).join(" "));
  }

  function updateMapping(field: RosterField, index: string) {
    setPreviewRefreshKey((previous) => previous + 1);
    setMapping((previous) => ({ ...previous, [field]: index === "" ? null : Number(index) }));
    setPreviewRows([]);
    setPage(0);
    setCorrectionsByRow({});
    setUnappliedCorrections(false);
  }

  const buildPreview = useCallback(() => {
    try {
      if (!selectedHeader || !file) throw new Error("Lee el archivo y selecciona la fila de encabezados.");
      const confirmedSkips = new Set(previewRows.filter((row) => row.skipConfirmed).map((row) => row.source_row));
      const applyCorrections = (sourceRows: RosterGridRow[], sourceOffset = 0) => sourceRows.map((sourceRow) => {
        const rowCorrections = correctionsByRow[sourceRow.sourceRow + sourceOffset];
        if (!rowCorrections) return sourceRow;
        const cells = [...sourceRow.cells];
        for (const [field, value] of Object.entries(rowCorrections) as [RosterField, string][]) {
          const columnIndex = mapping[field];
          if (columnIndex == null) continue;
          cells[columnIndex] = { ...(cells[columnIndex] ?? { value: "" }), value, formulaWithoutResult: false, unsafeNumber: false };
        }
        return { ...sourceRow, cells };
      });
      let rows: RosterImportRow[];
      if (file.name.toLowerCase().endsWith(".xlsx") && allSheets) {
        let referenceHeaders: string | null = null;
        rows = sheets.flatMap((sheet, sheetIndex) => {
          const headerIndex = detectHeaderRow(sheet.rows);
          if (headerIndex < 0) throw new Error(`La hoja “${sheet.name}” no tiene encabezados reconocibles.`);
          const header = sheet.rows[headerIndex];
          const sheetSourceRows = sheet.rows.filter((row) => row.sourceRow > header.sourceRow);
          const sheetColumns = buildColumns(header, sheetSourceRows);
          const signature = JSON.stringify(sheetColumns.map((column) => column.name.trim().normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-CL")));
          if (referenceHeaders !== null && signature !== referenceHeaders) {
            throw new Error(`La hoja “${sheet.name}” no tiene los mismos encabezados y orden que la primera hoja.`);
          }
          referenceHeaders = signature;
          const normalized = normalizeRosterRows(applyCorrections(sheetSourceRows, sheetIndex * 10000),
            sheetColumns, mapping, sheet.name, sheet.name);
          return normalized.map((row) => {
            const sourceRow = row.source_row + sheetIndex * 10000;
            return { ...row, source_row: sourceRow, corrections: correctionsByRow[sourceRow] ?? {}, matchTarget: null, skipConfirmed: confirmedSkips.has(sourceRow) };
          });
        });
        if (rows.length > 6000) throw new Error("El libro supera 6000 filas con datos.");
      } else {
        const sourceRows = gridRows.filter((row) => row.sourceRow > selectedHeader.sourceRow);
        if (sourceRows.length > 6000) throw new Error("La hoja supera 6000 filas con datos.");
        const fallbackDistance = defaultDistance;
        rows = normalizeRosterRows(applyCorrections(sourceRows), columns, mapping, fallbackDistance, sheetName || null)
          .map((row) => ({ ...row, corrections: correctionsByRow[row.source_row] ?? {}, matchTarget: null, skipConfirmed: confirmedSkips.has(row.source_row) }));
      }
      const byId = participantsById;
      const requireConfiguredDistance = (row: PreviewRow) => {
        if (row.operation === "skip" && !row.matchTarget) return row;
        const distance = normalizeDistance(row.participant.distance ?? "");
        if (!distance) {
          row.operation = "skip";
          row.issues.push({ level: "error", message: "Falta la distancia. Asígnala en el archivo o en “Distancia si falta en el archivo”." });
        } else if (!configuredDistanceKeys.has(distance)) {
          row.operation = "skip";
          row.issues.push({ level: "error", message: `La distancia ${distance} no está configurada para este evento.` });
        }
        return row;
      };
      const byBib = new Map<string, ExistingPerson[]>();
      const byChip = new Map<string, ExistingPerson[]>();
      for (const person of participants) {
        if (person.bib) byBib.set(person.bib, [...(byBib.get(person.bib) ?? []), person]);
        if (person.chip) byChip.set(person.chip, [...(byChip.get(person.chip) ?? []), person]);
      }
      const seenBibs = new Set<string>();
      const seenChips = new Set<string>();
      const prepared: PreviewRow[] = rows.map((row) => {
        const next: PreviewRow = {
          ...row,
          matchTarget: null,
          corrections: correctionsByRow[row.source_row] ?? {},
          skipConfirmed: confirmedSkips.has(row.source_row),
        };
        if (next.operation === "skip") return next;

        const mappedId = next.participant.participant_id;
        let match: ExistingPerson | null = null;
        if (mappedId) {
          match = byId.get(mappedId) ?? null;
          if (!match) {
            next.operation = "skip";
            next.issues.push({ level: "error", message: "El ID estable no corresponde a un participante de este evento." });
            return next;
          }
          next.matchTarget = match.participant_id;
          const merged = mergeUnmappedRosterFields(next.participant, match, next.mapped_fields);
          next.participant = merged.participant;
          next.mapped_fields = merged.mappedFields;
          next.operation = participantIsEqual(next.participant, match) ? "unchanged" : "update";
          return requireConfiguredDistance(next);
        }

        const bibMatches = next.participant.bib ? byBib.get(next.participant.bib) ?? [] : [];
        const chipMatches = next.participant.chip ? byChip.get(next.participant.chip) ?? [] : [];
        const candidates = [...new Map([...bibMatches, ...chipMatches].map((person) => [person.participant_id, person])).values()];
        if (candidates.length > 1) {
          next.operation = "skip";
          next.issues.push({ level: "error", message: "Dorsal y chip apuntan a participantes diferentes. Corrige el archivo o revisa esas identidades manualmente." });
          return next;
        }
        if (candidates.length === 1) {
          match = candidates[0];
          next.matchTarget = match.participant_id;
          const merged = mergeUnmappedRosterFields({ ...next.participant, participant_id: match.participant_id }, match, next.mapped_fields);
          next.participant = merged.participant;
          next.mapped_fields = merged.mappedFields;
          if (participantIsEqual(next.participant, match)) {
            next.operation = "unchanged";
          } else {
            next.operation = "skip";
            next.issues.push({ level: "warning", message: `Coincide con ${match.first_name} ${match.last_name ?? ""} (${match.bib || match.chip}). Elige actualizar o saltar esta fila.` });
          }
          return requireConfiguredDistance(next);
        }

        if ((next.participant.bib && seenBibs.has(next.participant.bib)) || (next.participant.chip && seenChips.has(next.participant.chip))) {
          next.operation = "skip";
          next.issues.push({ level: "error", message: "Dorsal o chip repetido en el archivo después de normalizar. Se requiere revisar la fila." });
          return next;
        }
        if (next.participant.bib) seenBibs.add(next.participant.bib);
        if (next.participant.chip) seenChips.add(next.participant.chip);
        return requireConfiguredDistance(next);
      });
      const previewBibs = new Map<string, number>();
      const previewChips = new Map<string, number>();
      const previewTargets = new Map<string, number>();
      for (const row of prepared) {
        if (row.operation === "skip") continue;
        const duplicateBib = row.participant.bib ? previewBibs.get(row.participant.bib) : undefined;
        const duplicateChip = row.participant.chip ? previewChips.get(row.participant.chip) : undefined;
        const target = row.operation === "update" || row.operation === "unchanged" ? row.matchTarget : null;
        const duplicateTarget = target ? previewTargets.get(target) : undefined;
        if (duplicateBib || duplicateChip || duplicateTarget) {
          row.operation = "skip";
          row.participant.participant_id = null;
          row.issues.push({ level: "error", message: `Fila duplicada dentro del archivo; ya aparece en la fila ${duplicateBib ?? duplicateChip ?? duplicateTarget}.` });
          continue;
        }
        if (row.participant.bib) previewBibs.set(row.participant.bib, row.source_row);
        if (row.participant.chip) previewChips.set(row.participant.chip, row.source_row);
        if (target) previewTargets.set(target, row.source_row);
      }
      if (!prepared.length) throw new Error("No hay filas con datos para revisar en este archivo.");
      setPreviewRows(prepared);
      setPage(0);
      setError("");
      setUnappliedCorrections(false);
      setMessage("Vista previa lista. Revisa las coincidencias y las filas omitidas antes de confirmar.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo preparar la vista previa.");
    }
  }, [allSheets, columns, correctionsByRow, file, gridRows, mapping, participants, participantsById, previewRows, selectedHeader, sheetName, sheets, defaultDistance, configuredDistanceKeys]);

  useEffect(() => {
    previewBuilder.current = buildPreview;
  }, [buildPreview]);

  useEffect(() => {
    if (!previewRefreshKey || !file || !selectedHeader || mapping.first_name == null) return;
    previewBuilder.current();
  }, [previewRefreshKey, file, selectedHeader, mapping.first_name]);

  function editCorrection(sourceRow: number, field: RosterField, value: string) {
    setCorrectionsByRow((previous) => ({
      ...previous,
      [sourceRow]: { ...previous[sourceRow], [field]: value },
    }));
    setUnappliedCorrections(true);
  }

  function confirmSkip(sourceRow: number, skipConfirmed: boolean) {
    setPreviewRows((previous) => previous.map((row) => row.source_row === sourceRow ? { ...row, skipConfirmed } : row));
  }

  function chooseOperation(sourceRow: number, operation: "update" | "skip") {
    setPreviewRows((previous) => previous.map((row) => {
      if (row.source_row !== sourceRow) return row;
      const participant = { ...row.participant, participant_id: operation === "update" ? row.matchTarget : null };
      return { ...row, participant, operation };
    }));
  }

  function savePreset() {
    if (!columns.length || !signature) return;
    const preset = { signature, mapping };
    localStorage.setItem(presetKey(eventId), JSON.stringify(preset));
    setSavedPreset(preset);
    setMessage("Mapeo guardado en este navegador.");
  }

  function loadPreset() {
    const source = savedPreset ?? (() => {
      try {
        const value = localStorage.getItem(presetKey(eventId));
        return value ? JSON.parse(value) as Preset : null;
      } catch {
        return null;
      }
    })();
    if (!source || source.signature !== signature) {
      setError("El mapeo guardado corresponde a otros encabezados.");
      return;
    }
    setPreviewRefreshKey((previous) => previous + 1);
    setMapping(source.mapping);
    setPreviewRows([]);
    setCorrectionsByRow({});
    setUnappliedCorrections(false);
    setMessage("Mapeo guardado aplicado. Confirma que cada columna siga siendo correcta.");
  }

  const operationLabels = { add: "Se incluirá", update: "Se actualizará", unchanged: "Sin cambios", skip: "Omitida" };
  const mappingJson = JSON.stringify(mapping);
  const operationsJson = JSON.stringify(previewRows.map((row) => ({
    source_row: row.source_row,
    operation: row.operation,
    corrections: row.corrections,
    skip_confirmed: row.skipConfirmed,
    participant_id: row.operation === "update" || row.operation === "unchanged" ? row.participant.participant_id : null,
    expected_values: row.matchTarget && (row.operation === "update" || row.operation === "unchanged")
      ? Object.fromEntries(row.mapped_fields.map((field) => [field, participantsById.get(row.matchTarget!)?.[field]]))
      : {},
  })));
  const requestBytes = file ? file.size + new Blob([mappingJson, operationsJson, sheetName, defaultDistance]).size + 20_000 : 0;
  const requestTooLarge = requestBytes > 11 * 1024 * 1024;

  return <div className="roster-importer">
    <form action={importRosterAction} className="roster-import-form">
      <input type="hidden" name="event_id" value={eventId} />
      <input type="hidden" name="mapping" value={mappingJson} />
      <input type="hidden" name="operations" value={operationsJson} />
      <input type="hidden" name="source_sheet" value={allSheets ? "__all__" : sheetName} />
      <input type="hidden" name="header_source_row" value={headerSourceRow ?? ""} />
      <input type="hidden" name="delimiter" value={delimiter} />
      <input type="hidden" name="encoding" value={encoding} />
      <input type="hidden" name="default_distance" value={defaultDistance} />

      <div className="roster-file-row">
        <label htmlFor={`roster-file-${eventId}`}>Archivo CSV o XLSX</label>
        <input
          className="file-input"
          id={`roster-file-${eventId}`}
          name="file"
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          required
          onChange={(event) => {
            const selectedFile = event.currentTarget.files?.[0] ?? null;
            setFile(selectedFile);
            if (inferredDefaultDistance.current) {
              inferredDefaultDistance.current = false;
              setDefaultDistance("");
            }
            setGridRows([]);
            setSheets([]);
            setAllSheets(false);
            setCsvText("");
            setPreviewRows([]);
            setCorrectionsByRow({});
            setUnappliedCorrections(false);
            setError("");
            setMessage("");
            if (selectedFile) void readSelectedFile(selectedFile);
          }}
        />
        <span className="roster-auto-read-note">La vista de nómina se genera automáticamente según el mapeo.</span>
        <a className="download-link" href="/nomina-plantilla.csv" download>Descargar plantilla</a>
        <a className="download-link" href={`/admin/events/${eventId}/roster`} download>Exportar con IDs estables</a>
      </div>
      <p className="setting-caption">CSV hasta 5 MB o XLSX hasta 10 MB comprimidos; máximo 5000 participantes, 30 hojas, 100 columnas y 250 000 celdas. No requiere Excel.</p>

      {file?.name.toLowerCase().endsWith(".csv") && <div className="roster-options">
        <label>Codificación<select value={encoding} onChange={(event) => {
          const nextEncoding = event.target.value as "utf-8" | "windows-1252";
          setEncoding(nextEncoding);
          if (csvText && file) {
            void file.arrayBuffer().then((buffer) => {
              const text = new TextDecoder(nextEncoding).decode(buffer);
              setCsvText(text);
              activateCsv(text, delimiter);
            });
          }
        }}><option value="utf-8">UTF-8</option><option value="windows-1252">Windows-1252</option></select></label>
        <label>Delimitador<select value={delimiter} onChange={(event) => {
          setDelimiter(event.target.value);
          if (csvText) activateCsv(csvText, event.target.value);
        }}><option value=",">Coma (,)</option><option value=";">Punto y coma (;)</option><option value="\t">Tabulación</option></select></label>
      </div>}

      {sheets.length > 0 && <>
        <label className="check-label"><input type="checkbox" checked={allSheets} onChange={(event) => { setPreviewRefreshKey((previous) => previous + 1); setAllSheets(event.target.checked); setPreviewRows([]); }} />
          Cargar todas las hojas, usando el nombre de cada hoja como distancia</label>
        <label className="roster-sheet-select">Hoja del libro
        <select value={sheetName} disabled={allSheets} onChange={(event) => {
          const nextSheet = sheets.find((sheet) => sheet.name === event.target.value);
          if (nextSheet) activateGrid(nextSheet.rows, nextSheet.name);
        }}>{sheets.map((sheet) => <option key={sheet.name} value={sheet.name}>{sheet.name} · {sheet.rows.length} filas con datos</option>)}</select>
      </label></>}

      {gridRows.length > 0 && <>
        <div className="roster-options">
          <label>Fila de encabezados
            <select value={headerSourceRow ?? ""} onChange={(event) => updateHeader(Number(event.target.value))}>
              {headerOptions.map((row, index) => <option key={row.sourceRow} value={row.sourceRow}>Fila {row.sourceRow} · {(row.cells.map((cell) => cell.value).filter(Boolean).slice(0, 5).join(" | ") || `Fila ${index + 1}`).slice(0, 100)}</option>)}
            </select>
          </label>
          <label>Distancia si falta en el archivo
            <input list={`roster-distances-${eventId}`} value={defaultDistance} onChange={(event) => { inferredDefaultDistance.current = false; setPreviewRefreshKey((previous) => previous + 1); setDefaultDistance(event.target.value); setPreviewRows([]); }} placeholder="Ej.: 10 KM" />
            <datalist id={`roster-distances-${eventId}`}>{distances.map((distance) => <option key={distance} value={distance} />)}</datalist>
          </label>
        </div>

        {selectedHeader && <div className="roster-mapping">
          <div className="roster-subheading"><div><h4>Mapear columnas</h4><p>Revisa las sugerencias y asigna cada campo una sola vez.</p></div>
            <div className="roster-preset-actions"><button type="button" className="button button-quiet button-small" onClick={loadPreset}>Usar mapeo guardado</button><button type="button" className="button button-quiet button-small" onClick={savePreset}>Guardar este mapeo</button></div>
          </div>
          <div className="roster-mapping-grid">
            {fieldOrder.map((field) => <label key={field}>{fieldLabels[field]}
              <select value={mapping[field] ?? ""} onChange={(event) => updateMapping(field, event.target.value)}>
                <option value="">— Sin asignar —</option>
                {columns.map((column) => {
                  const occupied = Object.entries(mapping).some(([otherField, index]) => otherField !== field && index === column.index);
                  return <option key={column.index} value={column.index} disabled={occupied}>{column.name} · columna {column.index + 1}{occupied ? " · usada" : ""}</option>;
                })}
              </select>
            </label>)}
          </div>
          <p className="setting-caption">Sin usar: {columns.filter((column) => !Object.values(mapping).includes(column.index)).map((column) => `${column.name} (col. ${column.index + 1})`).join(", ") || "ninguna"}</p>
        </div>}
      </>}

      {gridRows.length > 0 && previewRows.length === 0 && selectedHeader && <div className="roster-preview">
        <p className="roster-message">{mapping.first_name == null
          ? "Asigna una columna a Nombre para ver cómo quedará la nómina."
          : "Preparando la vista de la nómina con el mapeo actual…"}</p>
      </div>}

      {error && <p className="roster-message roster-message-error" role="alert">{error}</p>}
      {message && <p className="roster-message" role="status">{message}</p>}

      {previewRows.length > 0 && <div className="roster-preview">
        <p className="roster-message">Las filas válidas se procesarán juntas al confirmar el lote. Las que tienen errores requieren corrección o una omisión explícita.</p>
        <div className="roster-summary">
          <span><strong>{addedCount}</strong> altas</span><span><strong>{updatedCount}</strong> cambios</span><span><strong>{unchangedCount}</strong> iguales</span><span><strong>{skippedCount}</strong> omitidas</span><span><strong>{issueCount}</strong> incidencias</span>
        </div>
        {skippedCount > 0 && <p className="roster-message">Las filas omitidas y la causa quedan registradas en la versión de nómina.</p>}
        {requestTooLarge && <p className="roster-message roster-message-error" role="alert">El envío supera el límite seguro de 11 MB. Reduce columnas o divide la importación en archivos más pequeños.</p>}
        {unappliedCorrections && <p className="roster-message roster-message-pending">Hay correcciones sin validar. Revalida las filas antes de importar.</p>}
        {unresolvedErrorCount > 0 && <p className="roster-message roster-message-pending">{unresolvedErrorCount} fila{unresolvedErrorCount === 1 ? "" : "s"} con errores: corrígelas o marca expresamente que quieres omitirlas.</p>}
        <div className="table-wrap roster-preview-scroll">
          <table className="data-table roster-preview-table"><thead><tr><th>Fila</th>{rosterPreviewFields
            .filter(({ field }) => field !== "participant_id" || mapping.participant_id != null)
            .map(({ field, label }) => <th key={field}>{label}</th>)}<th>Estado</th><th>Validación</th></tr></thead><tbody>
            {currentPageRows.map((row) => {
              const canReviewMatch = Boolean(row.matchTarget) && (row.operation === "skip" || row.operation === "update");
              const hasBlockingError = row.issues.some((issue) => issue.level === "error");
              const hasIssues = row.issues.length > 0;
              const visibleFields = rosterPreviewFields.filter(({ field }) => field !== "participant_id" || mapping.participant_id != null);
              return <tr key={`${row.source_sheet ?? "csv"}-${row.source_row}`}>
                <td>{row.source_sheet ? `${row.source_sheet} · ` : ""}{row.source_row}</td>
                {visibleFields.map(({ field }) => {
                  const participantValue = row.participant[field];
                  const currentValue = participantValue == null ? "" : String(participantValue);
                  return <td key={field}>
                    {hasIssues && mapping[field] != null ? <input
                      className="roster-cell-editor"
                      aria-label={`Corregir ${fieldLabels[field]} en fila ${row.source_row}`}
                      value={correctionsByRow[row.source_row]?.[field] ?? currentValue}
                      onChange={(event) => editCorrection(row.source_row, field, event.target.value)}
                    /> : currentValue}
                  </td>;
                })}
                <td>{canReviewMatch && !hasBlockingError ? <select aria-label={`Acción para fila ${row.source_row}`} value={row.operation} onChange={(event) => chooseOperation(row.source_row, event.target.value as "update" | "skip")}><option value="skip">Omitir</option><option value="update">Actualizar coincidencia</option></select> : <div className="roster-row-status"><span className={`result-tag ${hasIssues && !hasBlockingError ? "roster-operation-review" : `roster-operation-${row.operation}`}`}>{hasBlockingError && !row.skipConfirmed ? "Corregir" : hasIssues && row.operation !== "skip" ? "Revisar · " + operationLabels[row.operation] : operationLabels[row.operation]}</span>
                  {hasBlockingError && <button type="button" className="roster-skip-button" onClick={() => confirmSkip(row.source_row, !row.skipConfirmed)}>{row.skipConfirmed ? "Deshacer omisión" : "Omitir esta fila"}</button>}
                </div>}</td>
                <td>{row.issues.length ? row.issues.map((issue, index) => <small className={issue.level === "error" ? "roster-issue-error" : "roster-issue-warning"} key={index}>{issue.message}</small>) : <span className="muted">Sin incidencias</span>}</td>
              </tr>;
            })}
          </tbody></table>
        </div>
        <div className="roster-preview-footer">
          <span>Filas {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, previewRows.length)} de {previewRows.length}</span>
          <div className="row-actions"><button type="button" className="button button-quiet button-small" onClick={() => setPage((previous) => Math.max(previous - 1, 0))} disabled={page === 0}>Anterior</button><button type="button" className="button button-quiet button-small" onClick={() => setPage((previous) => Math.min(previous + 1, Math.ceil(previewRows.length / PAGE_SIZE) - 1))} disabled={(page + 1) * PAGE_SIZE >= previewRows.length}>Siguiente</button></div>
        </div>
        {unappliedCorrections && <button type="button" className="button button-quiet button-small" onClick={buildPreview}>Revalidar filas corregidas</button>}
        <button className="button button-dark button-small" disabled={!confirmableCount || requestTooLarge || unresolvedErrorCount > 0 || unappliedCorrections}>
          {actionableCount ? `Confirmar e importar ${actionableCount} corredor${actionableCount === 1 ? "" : "es"}` : "Guardar revisión sin cambios"}
        </button>
      </div>}
    </form>

    {revisions.length > 0 && <details className="roster-history"><summary>Versiones de nómina · última revisión #{revisions[0].revision_no}</summary>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Versión</th><th>Archivo</th><th>Agregados</th><th>Actualizados</th><th>Sin cambios</th><th>Omitidos</th><th>Incidencias</th><th>Fecha</th></tr></thead><tbody>
        {revisions.map((revision) => <tr key={revision.revision_no}><td>#{revision.revision_no}</td><td>{revision.source_name}</td><td>{revision.added_count}</td><td>{revision.updated_count}</td><td>{revision.unchanged_count}</td><td>{revision.skipped_count}</td><td>{revision.issue_count}</td><td>{new Date(revision.created_at).toLocaleString("es-CL")}</td></tr>)}
      </tbody></table></div>
    </details>}
  </div>;
}
