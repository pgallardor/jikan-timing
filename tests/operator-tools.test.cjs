const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
// Exercise the production helpers without introducing a test-runner dependency.
require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, filename);
};
const { localDateTimeToUtc } = require("../lib/format.ts");
const { prepareManualFinishes, parsePastedFinishes } = require("../lib/manual-finishes.ts");
const { buildPodiumGroups, renderPodiumsPdf } = require("../lib/podium-export.ts");
const { buildCategoryCatalog, participantBaseCategory, categoryAfterDistanceChange, resolveCategoryChoice, existingCategoryChoice } = require("../lib/category-options.ts");
const runner = { id: "runner-1", bib: "001", name: "Camila Muñoz", startAt: "2026-11-22T12:00:00.125Z", finishAt: null, dnf: false };
const input = (patch = {}) => ({ bib: "001", mode: "elapsed", value: "32:10.125", reason: "", ...patch });

test("category catalog is scoped by distance, strips age suffixes and deduplicates case/spacing", () => {
  const catalog = buildCategoryCatalog([
    { distance: "10 km", category: " Élite   Varones · 30 a 39 años ", age_bracket: "30-39" },
    { distance: "10KM", category: "élite varones · 40 a 49 años", age_bracket: "40 a 49 años" },
    { distance: "5KM", category: "Juvenil", age_bracket: null },
    { distance: "5KM", category: null, age_bracket: null },
  ]);
  assert.deepEqual(catalog["10KM"], ["Élite Varones"]);
  assert.deepEqual(catalog["5KM"], ["Juvenil"]);
  assert.equal(participantBaseCategory("Masters · M35", "M35"), "Masters");
});
test("changing distance keeps a shared category and clears one unavailable in the new distance", () => {
  assert.equal(categoryAfterDistanceChange("élite", ["Juvenil", "Élite"]), "Élite");
  assert.equal(categoryAfterDistanceChange("Élite", ["Juvenil"]), null);
  assert.equal(categoryAfterDistanceChange(null, ["Juvenil"]), null);
});
test("category selection requires explicit creation and reuses existing canonical spelling", () => {
  const options = ["Élite Varones", "Promocional"];
  assert.equal(resolveCategoryChoice(existingCategoryChoice("élite varones"), "", options), "Élite Varones");
  assert.equal(resolveCategoryChoice("new", "  ÉLITE   VARONES ", options), "Élite Varones");
  assert.equal(resolveCategoryChoice("new", "  Nueva   categoría ", options), "Nueva categoría");
  assert.equal(resolveCategoryChoice("", "Ignored draft", options), null);
  assert.throws(() => resolveCategoryChoice(existingCategoryChoice("Juvenil"), "", options), /esta distancia/);
  assert.throws(() => resolveCategoryChoice("Nueva categoría", "", options), /Crear otra/);
});
test("new category rejects blank/oversized names and malformed selections", () => {
  assert.throws(() => resolveCategoryChoice("new", "   ", []));
  assert.throws(() => resolveCategoryChoice("new", "X".repeat(121), []));
  assert.throws(() => resolveCategoryChoice("existing:%invalid", "", []));
  assert.equal(resolveCategoryChoice(existingCategoryChoice('Categoría "A&B"'), "", ['Categoría "A&B"']), 'Categoría "A&B"');
});

test("manual elapsed and clock input preserve milliseconds and event timezone", () => {
  const rows = prepareManualFinishes([input()], [runner], "America/Santiago", "Control manual");
  assert.equal(rows[0].error, null);
  assert.equal(rows[0].prepared.captured_at, "2026-11-22T12:32:10.250Z");
  const clock = prepareManualFinishes([input({ mode: "clock", value: "2026-11-22T09:32:10.250" })], [runner], "America/Santiago", "Control manual");
  assert.deepEqual(clock[0].prepared, rows[0].prepared);
});
test("clock input supports next-day finishes", () => {
  assert.equal(localDateTimeToUtc("2026-11-23T00:12:01.003", "America/Santiago"), "2026-11-23T03:12:01.003Z");
});
test("invalid dates, hours and nonexistent DST wall times are rejected", () => {
  for (const date of ["2026-02-30T10:00", "2026-01-01T24:00", "2026-01-01T10:60", "2026-01-01T10:00:60"]) assert.throws(() => localDateTimeToUtc(date, "America/Santiago"));
  assert.throws(() => localDateTimeToUtc("2026-03-08T02:30:00", "America/New_York"), /no existe/);
  assert.equal(localDateTimeToUtc("2028-02-29T10:00", "UTC"), "2028-02-29T10:00:00.000Z");
});
test("manual sheet rejects duplicates, unknown bibs, DNF, missing starts and nonpositive times", () => {
  assert.match(prepareManualFinishes([input(), input()], [runner], "UTC", "Auditoría")[1].error, /repetido/);
  assert.match(prepareManualFinishes([input({ bib: "404" })], [runner], "UTC", "Auditoría")[0].error, /no pertenece/);
  assert.match(prepareManualFinishes([input()], [{ ...runner, dnf: true }], "UTC", "Auditoría")[0].error, /DNF/);
  assert.match(prepareManualFinishes([input()], [{ ...runner, startAt: null }], "UTC", "Auditoría")[0].error, /salida/);
  for (const value of ["00:00", "-01:20", "00:60:00", "100000000:01"]) assert.ok(prepareManualFinishes([input({ value })], [runner], "UTC", "Auditoría")[0].error);
  assert.match(prepareManualFinishes([input({ mode: "clock", value: "2026-11-22T11:00" })], [runner], "UTC", "Auditoría")[0].error, /posterior/);
});
test("row reasons override common reason and reviewed versions retain prior marks", () => {
  const result = prepareManualFinishes([input({ reason: "Video de llegada" })], [{ ...runner, finishAt: "2026-11-22T12:30:00.000Z" }], "UTC", "")[0];
  assert.equal(result.prepared.reason, "Video de llegada");
  assert.equal(result.prepared.expected_finish_at, "2026-11-22T12:30:00.000Z");
  assert.ok(prepareManualFinishes([input()], [runner], "UTC", "")[0].error);
});
test("Excel paste preserves leading-zero bibs, fractional commas, reasons and full dates", () => {
  assert.deepEqual(parsePastedFinishes("dorsal\ttiempo\tmotivo\n001\t32:10,123\tVideo\n002\t33:00\tPlanilla", "elapsed")[0], input({ value: "32:10,123", reason: "Video" }));
  assert.equal(parsePastedFinishes("001;2026-11-23 00:01:03.125;Video", "clock")[0].value, "2026-11-23T00:01:03.125");
  assert.throws(() => parsePastedFinishes("", "elapsed"));
  assert.throws(() => prepareManualFinishes(Array.from({ length: 5001 }, () => input()), [runner], "UTC", "Control"));
});

const candidate = (bib, time, patch = {}) => ({ participant_id: bib, bib, first_name: "José María", last_name: "Muñoz Pérez", team: "Club Ñuble", distance: "10KM", sex: "M", category: "10KM Varones · 30 a 39 años", age_bracket: "30 a 39 años", result_status: "FINALIZÓ", elapsed_seconds: time, overall_place: Number(bib), ...patch });
const people = [candidate("1", 10), candidate("2", 20), candidate("3", 30), candidate("4", 40), candidate("5", 50), candidate("6", 60)];
const policy = (exclude) => [{ distance: "10KM", award_policy_configured: true, exclude_general_top3_from_categories: exclude }];
test("podiums match RFID Local Race with general, base category and age groups", () => {
  const groups = buildPodiumGroups(people, policy(false));
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((g) => g.type), ["General", "Categoría", "Grupo etario"]);
  assert.equal(groups[1].category, "10KM Varones");
  groups.forEach((g) => assert.deepEqual(g.rows.map((r) => r.bib), ["1", "2", "3"]));
});
test("general exclusion only changes age podium, with replacement winners", () => {
  const groups = buildPodiumGroups(people, policy(true));
  assert.deepEqual(groups.find((g) => g.type === "Categoría").rows.map((r) => r.bib), ["1", "2", "3"]);
  assert.deepEqual(groups.find((g) => g.type === "Grupo etario").rows.map((r) => r.bib), ["4", "5", "6"]);
});
test("podiums preserve rank ties including multiple people in third place", () => {
  const tied = people.map((p, i) => ({ ...p, elapsed_seconds: [10, 20, 30, 30, 50, 60][i], overall_place: [1, 2, 3, 3, 5, 6][i] }));
  buildPodiumGroups(tied, policy(false)).forEach((g) => assert.deepEqual(g.rows.map((r) => r.place), [1, 2, 3, 3]));
});
test("podiums separate distances, sexes and categories and ignore invalid results", () => {
  const groups = buildPodiumGroups([...people,
    candidate("7", 10, { distance: "5km", sex: "F", category: "Juvenil", age_bracket: null, overall_place: 1 }),
    candidate("8", 1, { result_status: "DNF" }), candidate("9", -10), candidate("10", null), candidate("11", "NaN"),
  ], policy(false));
  assert.ok(groups.some((g) => g.distance === "5KM" && g.sex === "Damas"));
  assert.ok(groups.every((g) => g.rows.every((r) => !["8", "9", "10", "11"].includes(r.bib))));
});
test("PDF has valid object offsets, multiple pages, accented text and an empty-state report", () => {
  const groups = buildPodiumGroups(people, policy(false));
  const longGroups = Array.from({ length: 14 }, (_, i) => ({ ...groups[i % groups.length], category: `Categoría ${i} · Categoría de prueba con nombre extenso para verificar saltos de línea` }));
  const pdf = Buffer.from(renderPodiumsPdf({ name: "Carrera Ñuble · José", date: "2026-11-22", exportedAt: "22-11-2026 09:30" }, longGroups));
  const source = pdf.toString("latin1");
  assert.ok(source.startsWith("%PDF-1.4"));
  assert.ok(source.includes(Buffer.from("José María Muñoz Pérez", "latin1").toString("hex")));
  const xref = Number(source.match(/startxref\n(\d+)/)[1]);
  assert.equal(source.slice(xref, xref + 4), "xref");
  for (const match of source.matchAll(/(\d{10}) 00000 n /g)) assert.match(source.slice(Number(match[1])), /^\d+ 0 obj/);
  assert.ok((source.match(/\/Type \/Page\b/g) ?? []).length > 1);
  const out = process.env.OPERATOR_QA_OUTPUT;
  if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "podios-prueba.pdf"), pdf); }
  const empty = Buffer.from(renderPodiumsPdf({ name: "Sin resultados", date: "Por definir", exportedAt: "Hoy" }, []));
  assert.ok(empty.length > 400);
});
