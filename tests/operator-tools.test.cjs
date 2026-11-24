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
const { categoryIdentity, categoryLabel, ageGroupValue } = require("../lib/classification.ts");
const runner = { id: "runner-1", bib: "001", name: "Camila Muñoz", startAt: "2026-11-22T12:00:00.125Z", finishAt: null, dnf: false };
const input = (patch = {}) => ({ bib: "001", mode: "elapsed", value: "32:10.125", reason: "", ...patch });

test("category identity ignores names and uses normalized criterion values", () => {
  const a={sex:"F",age_bracket:"30-39",category:"Inventada"};
  assert.equal(categoryIdentity(a),categoryIdentity({...a,age_bracket:"30 a 39 años",category:"Otro nombre"}));
  assert.equal(categoryLabel(a),"Damas · 30 a 39 años");
  assert.notEqual(categoryIdentity(a),categoryIdentity({...a,sex:"M"}));
  assert.notEqual(categoryIdentity(a),categoryIdentity({...a,age_bracket:"40–49"}));
  for(const age of [null,"", "35", "50-30", "90-130"]) assert.equal(categoryIdentity({...a,age_bracket:age}),null);
  assert.equal(categoryIdentity({...a,sex:"no_informado"}),null);
  assert.equal(ageGroupValue(" u18 "),"U18");
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

const candidate = (bib, time, patch = {}) => ({ participant_id: bib, bib, first_name: "José María", last_name: "Muñoz Pérez", team: "Club Ñuble", distance: "10KM", sex: "M", category: "10KM Varones · 30 a 39 años", age_bracket: "30 a 39 años", result_status: "FINALIZÓ", elapsed_seconds: time, overall_place: Number(bib), category_place: Number(bib), ...patch });
const people = [candidate("1", 10), candidate("2", 20), candidate("3", 30), candidate("4", 40), candidate("5", 50), candidate("6", 60)];
const policy = (exclude) => [{ distance: "10KM", award_policy_configured: true, exclude_general_top3_from_categories: exclude }];
test("PDF has just general and calculated category, independent of imported names", () => {
  const renamed=people.map((p,i)=>({...p,category:i%2 ? "Élite" : "Nombre libre"}));
  const groups=buildPodiumGroups(renamed,policy(false));
  assert.deepEqual(groups.map((g)=>g.type),["General","Categoría"]);
  groups.forEach((g)=>assert.deepEqual(g.rows.map((r)=>r.bib),["1","2","3"]));
});
test("PDF consumes official category ranks including promoted places without reranking", () => {
  const classified=people.map((p,i)=>({...p,category_place:i<3 ? null : i-2}));
  const groups=buildPodiumGroups(classified,policy(true));
  assert.deepEqual(groups[1].rows.map((r)=>[r.bib,r.place]),[["4",1],["5",2],["6",3]]);
  const gaps=buildPodiumGroups([candidate("1",10,{category_place:2}),candidate("2",20,{category_place:4})],[]);
  assert.deepEqual(gaps[1].rows.map((r)=>r.place),[2]);
});
test("missing criteria never fall back to the imported category label",()=>{
  const groups=buildPodiumGroups([candidate("1",10,{age_bracket:null,category:"Varones · 30 a 39 años",category_place:null})],[]);
  assert.deepEqual(groups.map((g)=>g.type),["General"]);
});

test("RUT-like IDs are removed from team exports while club names and years remain", () => {
  for (const team of ["12.345.678-5", "123456785", "12345678-K", "RUT: 12.345.678-5"]) {
    const groups = buildPodiumGroups([candidate("1", 10, { team })], policy(false));
    assert.ok(groups.every((g) => g.rows[0].team === ""), team);
  }
  assert.equal(buildPodiumGroups([candidate("1", 10, { team: "Club Ñuble (RUT: 12.345.678-5)" })], [])[0].rows[0].team, "Club Ñuble");
  for (const team of ["Club 2026", "Team123456789", "Ñuble Runners", "'-"]) assert.equal(buildPodiumGroups([candidate("1", 10, { team })], [])[0].rows[0].team, team);
  const groups = [{ distance: "10KM", type: "General", sex: "Varones", category: "", ageBracket: "", rows: [{ place: 1, bib: "1", name: "Corredor", team: "12.345.678-5", time: "00:10:00.000" }] }];
  const pdf = Buffer.from(renderPodiumsPdf({ name: "Privacidad", date: "Hoy", exportedAt: "Hoy" }, groups)).toString("latin1");
  assert.ok(!pdf.includes(Buffer.from("12.345.678-5").toString("hex")));
});

test("PDF keeps small podiums whole and every continuation heading has participant rows", () => {
  const groups = Array.from({ length: 35 }, (_, i) => ({
    distance: "10KM", type: "Grupo etario", sex: "Varones", category: `Serie ${i}`, ageBracket: "30 a 39 años",
    rows: Array.from({ length: i === 15 ? 30 : i % 4 + 1 }, (_, j) => ({ place: j + 1, bib: `${i}-${j}`, name: `Runner-${i}-${j}`, team: i % 3 ? "Club" : "Equipo con un nombre largo que necesita varias líneas dentro de la columna de equipo", time: "00:10:00.000" })),
  }));
  const pdf = Buffer.from(renderPodiumsPdf({ name: "Paginación", date: "Hoy", exportedAt: "Hoy" }, groups)).toString("latin1");
  const pages = [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((match) => [...match[1].matchAll(/Tm <([a-f0-9]+)> Tj/g)].map((text) => Buffer.from(text[1], "hex").toString("latin1")));
  for (const texts of pages) {
    const headings = texts.flatMap((text, i) => text.startsWith("10KM · Grupo etario") ? [i] : []);
    headings.forEach((start, i) => assert.ok(texts.slice(start + 1, headings[i + 1] ?? texts.length).some((text) => text.startsWith("Runner-")), "Orphan podium heading"));
  }
  groups.forEach((group, i) => {
    const rowPages = pages.flatMap((texts, page) => texts.some((text) => text.startsWith(`Runner-${i}-`)) ? [page] : []);
    assert.ok(i === 15 ? rowPages.length > 1 : rowPages.length === 1, `Unexpected split for small podium ${i}`);
    group.rows.forEach((row) => assert.equal(pages.flat().filter((text) => text === row.name).length, 1));
  });
});

test("podiums preserve rank ties including multiple people in third place", () => {
  const tied = people.map((p, i) => ({ ...p, elapsed_seconds: [10, 20, 30, 30, 50, 60][i], overall_place: [1, 2, 3, 3, 5, 6][i], category_place:[1,2,3,3,5,6][i] }));
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
