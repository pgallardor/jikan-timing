import { normalizeDistance } from "./participant-category";
import { categoryIdentity, ageGroupValue } from "./classification";
import { participantDisplayName } from "./format";

export type PodiumCandidate = {
  participant_id: string; bib: string | null; first_name: string; last_name: string | null; team: string | null;
  distance: string | null; sex: string | null; category: string | null; age_bracket: string | null;
  result_status: string; elapsed_seconds: number | string | null; overall_place: number | null; category_place: number | null;
};
export type PodiumPolicy = { distance: string; award_policy_configured: boolean; exclude_general_top3_from_categories: boolean };
export type PodiumRow = { place: number; bib: string; name: string; team: string; time: string };
export type PodiumGroup = { distance: string; type: "General" | "Categoría" | "Grupo etario"; sex: string; category: string; ageBracket: string; rows: PodiumRow[] };
const collate = (a: string, b: string) => a.localeCompare(b, "es-CL", { numeric: true, sensitivity: "base" });
const key = (...parts: string[]) => JSON.stringify(parts.map((part) => part.trim().toLocaleUpperCase("es-CL")));
const sexLabel = (sex: string | null) => sex === "F" ? "Damas" : sex === "M" ? "Varones" : sex === "otro" ? "Otro" : "Sin informar";

function publicTeamLabel(value: string) {
  // Some source rosters placed a RUT in the club column. Never print that ID.
  const scrubbed = value.replace(/(?<![\p{L}\p{N}])(?:(?:rut|run)\s*:?\s*)?(?:\d{1,2}(?:\.\d{3}){2}|\d{6,8})\s*-?\s*[\dkK](?![\p{L}\p{N}])/giu, "");
  if (scrubbed === value) return value;
  return scrubbed.replace(/\(\s*\)|\[\s*\]/g, "").replace(/^[\s,;:|/·—–'"-]+|[\s,;:|/·—–'"-]+$/g, "").replace(/\s+/g, " ").trim();
}

function duration(seconds: number) {
  const ms = Math.round(seconds * 1000);
  const whole = Math.floor(ms / 1000);
  return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60].map((p) => String(p).padStart(2, "0")).join(":") + "." + String(ms % 1000).padStart(3, "0");
}

// PDF renders official general/category places without reconstructing groups from names.
export function buildPodiumGroups(participants: PodiumCandidate[], policies: PodiumPolicy[]): PodiumGroup[] {
  // Policy and replacement ranks have already been applied by the results engine.
  void policies;
  const groups = new Map<string, { group: PodiumGroup; people: PodiumCandidate[] }>();
  function add(person: PodiumCandidate, type: PodiumGroup["type"], category = "", ageBracket = "") {
    const distance = normalizeDistance(person.distance ?? "") ?? "Sin distancia";
    const sex = sexLabel(person.sex);
    const groupKey = key(distance, type, person.sex ?? "", category, ageBracket);
    let entry = groups.get(groupKey);
    if (!entry) { entry = { group: { distance, type, sex, category, ageBracket, rows: [] }, people: [] }; groups.set(groupKey, entry); }
    entry.people.push(person);
  }
  for (const person of participants) {
    if (person.result_status !== "FINALIZÓ" || person.elapsed_seconds === null || !Number.isFinite(Number(person.elapsed_seconds)) || Number(person.elapsed_seconds) < 0) continue;
    add(person, "General");
    if (categoryIdentity(person) && person.category_place != null) add(person, "Categoría", "", ageGroupValue(person.age_bracket) ?? "");
  }
  for (const { group, people } of groups.values()) {
    people.sort((a, b) => Number(a.elapsed_seconds) - Number(b.elapsed_seconds) || collate(a.bib ?? "", b.bib ?? ""));
    for (const person of people) {
      const place = Number(group.type === "General" ? person.overall_place : person.category_place);
      if (place >= 1 && place <= 3) group.rows.push({ place, bib: person.bib ?? "—", name: participantDisplayName(person.first_name, person.last_name), team: publicTeamLabel(person.team ?? ""), time: duration(Number(person.elapsed_seconds)) });
    }
  }
  const order = { General: 0, "Categoría": 1, "Grupo etario": 2 };
  return [...groups.values()].map(({ group }) => group).filter((g) => g.rows.length).sort((a, b) =>
    collate(a.distance, b.distance) || order[a.type] - order[b.type] || collate(a.sex, b.sex) || collate(a.category, b.category) || collate(a.ageBracket, b.ageBracket));
}

// Small, dependency-free PDF writer using the same WinAnsi font as RFID Local Race.
const extraWinAnsi: Record<string, number> = { "€": 128, "‚": 130, "ƒ": 131, "„": 132, "…": 133, "†": 134, "‡": 135, "ˆ": 136, "‰": 137, "Š": 138, "‹": 139, "Œ": 140, "Ž": 142, "‘": 145, "’": 146, "“": 147, "”": 148, "•": 149, "–": 150, "—": 151, "˜": 152, "™": 153, "š": 154, "›": 155, "œ": 156, "ž": 158, "Ÿ": 159 };
function hexText(value: string) {
  return [...value.normalize("NFC").replace(/[\r\n\t]/g, " ")].map((c) => (extraWinAnsi[c] ?? (c.charCodeAt(0) <= 255 ? c.charCodeAt(0) : 63)).toString(16).padStart(2, "0")).join("");
}
function textWidth(value: string, size: number) {
  return [...value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")].reduce((width, c) => width +
    (/[ilI.,'!:;| ]/.test(c) ? 0.28 : /[MW@%]/.test(c) ? 0.95 : /[A-Z]/.test(c) ? 0.73 : 0.58) * size, 0);
}
function wrap(value: string, width: number, size: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of value.replace(/\s+/g, " ").trim().split(" ")) {
    if (line && textWidth(line + " " + word, size) > width) { lines.push(line); line = ""; }
    for (const char of (line ? " " : "") + word) {
      if (line && textWidth(line + char, size) > width) { lines.push(line); line = ""; }
      line += char;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

export function renderPodiumsPdf(event: { name: string; date: string; exportedAt: string }, groups: PodiumGroup[]): Uint8Array {
  const pages: string[][] = [];
  let commands: string[] = [];
  let y = 0;
  let contentTop = 0;
  const bottom = 42;
  const headingLines = (group: PodiumGroup, continued = false) => wrap([group.distance, group.type, group.sex, group.category, group.ageBracket, continued ? "continuación" : ""].filter(Boolean).join(" · "), 756, 11);
  const headingHeight = (lines: string[]) => lines.length * 15 + 37;
  const rowLayout = (row: PodiumRow) => {
    const widths = [39, 65, 390, 147, 85];
    const lines = [String(row.place), row.bib, row.name, publicTeamLabel(row.team), row.time].map((cell, i) => wrap(cell, widths[i], 10));
    return { lines, height: Math.max(...lines.map((cell) => cell.length)) * 13 + 10 };
  };
  const text = (x: number, py: number, size: number, value: string, bold = false) => commands.push(`BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x} ${py} Tm <${hexText(value)}> Tj ET`);
  function page() {
    commands = []; pages.push(commands);
    const title = wrap("PODIOS · " + event.name, 770, 18);
    title.forEach((line, i) => text(36, 556 - i * 22, 18, line, true));
    const metaY = 534 - (title.length - 1) * 22;
    text(36, metaY, 10, "Fecha: " + event.date + " · Todas las distancias");
    text(36, metaY - 17, 9, "Exportado: " + event.exportedAt);
    y = metaY - 44;
    contentTop = y;
  }
  function groupHeading(group: PodiumGroup, firstRowHeight: number, continued = false) {
    const lines = headingLines(group, continued);
    if (y - headingHeight(lines) - firstRowHeight < bottom) page();
    commands.push(`0.12 0.29 0.43 rg 36 ${y - lines.length * 15 + 1} 770 ${lines.length * 15 + 12} re f 1 1 1 rg`);
    lines.forEach((line, i) => text(43, y - i * 15, 11, line, true));
    commands.push("0 0 0 rg");
    y -= lines.length * 15 + 18;
    ["Puesto", "Dorsal", "Corredor", "Equipo", "Tiempo"].forEach((label, i) => text([40, 87, 160, 560, 717][i], y, 9, label, true));
    y -= 19;
  }
  page();
  const nonemptyGroups = groups.filter((group) => group.rows.length > 0);
  if (!nonemptyGroups.length) text(36, y, 12, "Aún no hay podios con tiempos válidos.");
  for (const group of nonemptyGroups) {
    const rows = group.rows.map(rowLayout);
    const blockHeight = headingHeight(headingLines(group)) + rows.reduce((total, row) => total + row.height, 0);
    // Keep an entire podium together when it fits on a fresh page. Large ties
    // may continue, but a heading always has room for its first complete row.
    if (blockHeight <= contentTop - bottom && y - blockHeight < bottom) page();
    groupHeading(group, rows[0].height);
    for (const { lines, height } of rows) {
      if (y - height < bottom) { page(); groupHeading(group, height, true); }
      lines.forEach((cellLines, i) => cellLines.forEach((line, j) => text([40, 87, 160, 560, 717][i], y - j * 13, 10, line)));
      y -= height;
      commands.push(`0.8 G 0.4 w 36 ${y + 8} m 806 ${y + 8} l S 0 G`);
    }
    y -= 19;
  }
  const objects: Buffer[] = [Buffer.alloc(0), Buffer.alloc(0)];
  const fontId = 3 + pages.length * 2;
  const pageIds: number[] = [];
  pages.forEach((content, index) => {
    const pageId = 3 + index * 2; pageIds.push(pageId);
    content.push(`BT /F1 8 Tf 1 0 0 1 713 22 Tm <${hexText(`Página ${index + 1} de ${pages.length}`)}> Tj ET`);
    const stream = Buffer.from(content.join("\n"), "ascii");
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${fontId + 1} 0 R >> >> /Contents ${pageId + 1} 0 R >>`));
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")]));
  });
  objects.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
  objects.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"));
  objects[0] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>");
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  const chunks = [Buffer.from("%PDF-1.4\n%âãÏÓ\n", "latin1")];
  const offsets = [0]; let offset = chunks[0].length;
  objects.forEach((object, i) => { offsets.push(offset); const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]); chunks.push(chunk); offset += chunk.length; });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`));
  return new Uint8Array(Buffer.concat(chunks));
}
