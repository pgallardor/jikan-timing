// Runs against loopback Supabase + a compiled local Next.js server only.
// Creates disposable accounts/events and removes only those UUIDs in cleanup.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createClient } = require("@supabase/supabase-js");
const { createServerClient } = require("@supabase/ssr");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);
const { prepareManualFinishes } = require("../lib/manual-finishes.ts");
const { buildPodiumGroups } = require("../lib/podium-export.ts");

const url = process.env.OPERATOR_SUPABASE_URL;
const key = process.env.OPERATOR_SUPABASE_KEY;
const appUrl = process.env.OPERATOR_LOCAL_APP_URL || "http://127.0.0.1:3100";
for (const target of [url, appUrl]) {
  const parsed = new URL(target);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname), "Integration tests must never target a remote host");
}
assert.equal(new URL(url).port, "55421", "Use this project's local Supabase instance");
const output = path.join(__dirname, "../local-backups/operator-qa");
fs.mkdirSync(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), targets: { supabase: url, web: appUrl }, checks: [] };
const fields = ["bib", "chip", "first_name", "last_name", "sex", "rut", "distance", "age", "age_bracket", "category", "team", "dnf_at"];
const expected = (p) => Object.fromEntries(fields.map((field) => [field, p[field]]));
const valueFields = (p) => Object.fromEntries(fields.filter((field) => field !== "dnf_at").map((field) => [field, p[field]]));
const sql = (text) => execFileSync("docker", ["exec", "supabase_db_crono-criteria-synthetic", "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-At", "-c", text], { encoding: "utf8", windowsHide: true }).trim();
const unwrap = (result) => { assert.equal(result.error, null, result.error?.message); return result.data; };
const actionIds = new Map();
for (const filename of fs.readdirSync(path.join(__dirname, "../.next/static/chunks/app/admin/events/[id]"))) {
  if (!filename.endsWith(".js")) continue;
  const source = fs.readFileSync(path.join(__dirname, "../.next/static/chunks/app/admin/events/[id]", filename), "utf8");
  for (const match of source.matchAll(/createServerReference\)\("([a-f0-9]+)",[^)]*?"(\w+)"\)/g)) actionIds.set(match[2], match[1]);
}

test("local operator integration", { timeout: 300_000 }, async (t) => {
  const accounts = [];
  const baseline = sql("select (select count(*) from public.events) || ':' || (select count(*) from public.event_participants)");
  async function account() {
    const jar = new Map();
    const client = createServerClient(url, key, { cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => jar.set(name, value)),
    }, auth: { autoRefreshToken: false } });
    const data = unwrap(await client.auth.signUp({ email: `qa-${randomUUID()}@example.test`, password: randomUUID() + "aA1!" }));
    assert.ok(data.session, "Local test account must have a confirmed session");
    accounts.push(data.user.id);
    return { client, id: data.user.id, cookie: () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ") };
  }
  t.after(() => {
    // UUIDs come only from accounts created in this run; no existing user is selected.
    for (const id of accounts) assert.match(id, /^[0-9a-f-]{36}$/);
    if (accounts.length) sql(`do $$ declare e record; begin for e in select id from public.events where owner_id in (${accounts.map((id) => `'${id}'::uuid`).join(",")}) loop perform set_config('app.d07_transfer_event_id',e.id::text,true); delete from public.events where id=e.id; end loop; delete from auth.users where id in (${accounts.map((id) => `'${id}'::uuid`).join(",")}); end $$;`);
    report.cleanedUp = true;
    report.finishedAt = new Date().toISOString();
    report.baselineRestored = sql("select (select count(*) from public.events) || ':' || (select count(*) from public.event_participants)") === baseline;
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    assert.ok(report.baselineRestored, "Existing local event/participant counts must be unchanged");
  });
  async function check(name, callback) {
    await t.test(name, async () => {
      const start = performance.now();
      try { await callback(); report.checks.push({ name, passed: true, milliseconds: Math.round(performance.now() - start) }); }
      catch (error) { report.checks.push({ name, passed: false, error: error.message }); fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2)); throw error; }
    });
  }
  const owner = await account();
  const outsider = await account();
  const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const slug = "qa-tools-" + randomUUID();
  const event = unwrap(await owner.client.from("events").insert({ owner_id: owner.id, name: "QA local · Carrera Ñuble", slug, event_date: "2026-11-22", timezone: "America/Santiago", status: "open" }).select().single());
  unwrap(await owner.client.from("event_distances").insert(["10KM", "5KM"].map((distance) => ({ event_id: event.id, distance, award_policy_configured: true, exclude_general_top3_from_categories: distance === "10KM" }))));
  const bibs = ["001", "002", "003", "004", "005", "006", "101", "102", "103", "104", "201", "202", "203", "204", "205", "206"];
  const people = bibs.map((bib) => {
    const female = bib.startsWith("1") || ["202", "203"].includes(bib);
    const bracket = female ? "20 a 29 años" : "30 a 39 años";
    const distance = female ? "5KM" : "10KM";
    return { participant_id: null, bib, chip: "QA" + slug.slice(-8).replace(/-/g, "") + bib, first_name: "José", last_name: "Muñoz " + bib, sex: female ? "F" : "M", rut: null, age: female ? 25 : 35, age_bracket: bracket, category: `${distance} ${female ? "Damas" : "Varones"} · ${bracket}`, distance, team: bib === "005" ? "12.345.678-5" : "Club Ñuble" };
  });
  unwrap(await owner.client.rpc("import_event_roster", {
    p_event_id: event.id, p_rows: people.map((p, i) => ({ source_row: i + 1, source_sheet: null, source_values: Object.values(p).map((v) => v === null ? "" : String(v)), mapped_fields: fields.filter((f) => f !== "dnf_at"), expected_values: {}, participant: p, operation: "add", issues: [] })),
    p_source_name: "QA local desechable", p_source_kind: "manual", p_source_sha256: createHash("sha256").update(slug).digest("hex"), p_mapping: {},
  }));
  const participant = async (bib) => unwrap(await owner.client.from("event_participants").select("*").eq("event_id", event.id).eq("bib", bib).single());
  const results = async () => unwrap(await owner.client.from("event_results").select("*").eq("event_id", event.id));
  const result = async (bib) => (await results()).find((p) => p.bib === bib);
  const audit = async () => unwrap(await owner.client.from("timing_entry_audit").select("*").eq("event_id", event.id));
  const changes = async () => unwrap(await owner.client.from("participant_change_audit").select("*").eq("event_id", event.id));
  const change = (person, operation, values = valueFields(person), client = owner.client) => client.rpc("change_event_participant", { p_event_id: event.id, p_participant_id: person.id, p_action: operation, p_values: values, p_expected: expected(person), p_reason: "Prueba de integración local" });
  for (const distance of ["10KM", "5KM"]) unwrap(await owner.client.rpc("record_distance_start_manually", { p_event_id: event.id, p_distance: distance, p_captured_at: "2026-11-22T12:00:00.125Z", p_reason: "Salida oficial para QA", p_confirm_replace: false }));
  const noStart = await participant("203");
  unwrap(await owner.client.rpc("void_timing_entry", { p_event_id: event.id, p_participant_id: noStart.id, p_stage: "start", p_reason: "Prueba sin salida" }));
  async function formAction(name, values, actor = owner) {
    if (!actionIds.has(name) && name === "addParticipantAction") {
      const response = await fetch(`${appUrl}/admin/events/${values.event_id}`, { headers: { Cookie: actor.cookie() } });
      assert.equal(response.status, 200);
      const html = await response.text();
      const addForm = html.match(/<form\b[^>]*class="participant-form"[^>]*>[\s\S]*?<\/form>/)?.[0];
      const actionId = addForm?.match(/name="\$ACTION_ID_([a-f0-9]+)"/)?.[1];
      assert.ok(actionId, "Add form must expose its native Server Action");
      actionIds.set(name, actionId);
    }
    assert.ok(actionIds.get(name), `Missing compiled Server Action: ${name}`);
    const form = new FormData(); form.set("$ACTION_ID_" + actionIds.get(name), "");
    for (const [key, value] of Object.entries(values)) form.set(key, value === null ? "" : String(value));
    const response = await fetch(`${appUrl}/admin/events/${values.event_id ?? event.id}`, { method: "POST", body: form, headers: { Cookie: actor.cookie(), Origin: appUrl }, redirect: "manual" });
    assert.equal(response.status, 303, `Server Action should redirect, received ${response.status}`);
    return new URL(response.headers.get("location"), appUrl);
  }
  async function changeForm(person, operation, values = {}, actor = owner) {
    return formAction("changeParticipantAction", { event_id: event.id, participant_id: person.id, operation, expected: JSON.stringify(expected(person)), reason: "Revisión de planilla local", confirm_remove: "on", ...valueFields(person), ...values }, actor);
  }
  async function prepare(inputs) {
    const current = await results();
    const rows = prepareManualFinishes(inputs, current.map((p) => ({ id: p.participant_id, bib: p.bib, name: p.first_name, startAt: p.start_at, finishAt: p.finish_at, dnf: p.result_status === "DNF" })), "America/Santiago", "Control manual local");
    rows.forEach((p) => assert.equal(p.error, null, p.error));
    return rows.map((p) => p.prepared);
  }
  const elapsed = (bib, value) => ({ bib, mode: "elapsed", value, reason: "" });
  const clock = (bib, value) => ({ bib, mode: "clock", value, reason: "Hora de video local" });
  async function batchForm(inputs, reviewed = null) {
    const rows = reviewed ?? await prepare(inputs);
    return formAction("recordManualFinishesBatchAction", { event_id: event.id, reason: "Control manual local", rows: JSON.stringify(rows.map((p, i) => ({ input: inputs[i], participant_id: p.participant_id, expected_start_at: p.expected_start_at, expected_finish_at: p.expected_finish_at }))) });
  }

  await check("admin page renders authenticated roster and all operator controls", async () => {
    const response = await fetch(`${appUrl}/admin/events/${event.id}`, { headers: { Cookie: owner.cookie() } });
    assert.equal(response.status, 200);
    const html = await response.text();
    for (const text of ["Editar", "Dar de baja", "Marcar DNF", "Planilla de llegadas manuales", "Descargar todos los podios PDF"]) assert.ok(html.includes(text), text);
    assert.ok(!html.includes("Estarán deshabilitadas hasta"));
    assert.ok(!html.includes("La vista de resultados no coincide"));
  });
  await check("web forms save criteria, ignore supplied category names and recalculate on edit", async () => {
    const target=unwrap(await owner.client.from("events").insert({owner_id:owner.id,name:"QA criterios",slug:"qa-tools-"+randomUUID(),event_date:"2026-11-23"}).select().single());
    unwrap(await owner.client.from("event_distances").insert({event_id:target.id,distance:"10KM",award_policy_configured:true}));
    const html=await (await fetch(appUrl+"/admin/events/"+target.id,{headers:{Cookie:owner.cookie()}})).text();
    assert.ok(html.includes("Categoría calculada"));assert.ok(!html.includes('name="category_choice"'));
    const added=await formAction("addParticipantAction",{event_id:target.id,bib:"C001",first_name:"Sintética",sex:"F",distance:"10KM",age_bracket:"30-39",category:"Nombre que debe ignorarse"});
    assert.ok(added.searchParams.has("ok"),added.searchParams.get("error"));
    const get=async()=>unwrap(await owner.client.from("event_participants").select("*").eq("event_id",target.id).eq("bib","C001").single());
    let p=await get();assert.equal(p.age_bracket,"30 a 39 años");
    let r=unwrap(await owner.client.from("event_results").select("*").eq("event_id",target.id).single());assert.equal(r.category,"Damas · 30 a 39 años");
    const updated=await formAction("changeParticipantAction",{event_id:target.id,participant_id:p.id,operation:"update",expected:JSON.stringify(expected(p)),...valueFields(p),sex:"M",age_bracket:"40–49",category:"Texto arbitrario",reason:"Reclasificación sintética"});
    assert.ok(updated.searchParams.has("ok"),updated.searchParams.get("error"));
    r=unwrap(await owner.client.from("event_results").select("*").eq("event_id",target.id).single());assert.equal(r.category,"Varones · 40 a 49 años");
    const invalid=await formAction("addParticipantAction",{event_id:target.id,bib:"C002",first_name:"Inválida",sex:"F",distance:"10KM",age_bracket:"50-30"});assert.ok(invalid.searchParams.has("error"));
  });
  await check("native web form edits stable participant and creates roster revision/audit", async () => {
    const before = await participant("001");
    const redirect = await changeForm(before, "update", { first_name: "José María", team: "Club Ñuble corregido", category: "10KM Varones" });
    assert.ok(redirect.searchParams.has("ok"), redirect.searchParams.get("error"));
    const after = await participant("001");
    assert.equal(after.id, before.id); assert.equal(after.first_name, "José María");
    assert.ok((await changes()).some((a) => a.action === "updated" && a.before_values.first_name === "José" && a.after_values.first_name === "José María"));
    const revisions = unwrap(await owner.client.from("event_roster_revisions").select("revision_no").eq("event_id", event.id));
    assert.equal(revisions.length, 2);
    assert.equal((await result("001")).start_at, "2026-11-22T12:00:00.125+00:00");
  });
  await check("duplicate bib/chip edits and stale roster versions fail without changes", async () => {
    const before = await participant("001");
    const duplicate = await changeForm(before, "update", { bib: "002" });
    assert.match(duplicate.searchParams.get("error"), /asignado/);
    assert.equal((await participant("001")).id, before.id);
    const duplicateChip = await change(before, "update", { ...valueFields(before), chip: (await participant("002")).chip });
    assert.equal(duplicateChip.error?.code, "23505");
    unwrap(await owner.client.from("event_participants").update({ team: "Cambio concurrente" }).eq("id", before.id));
    const stale = await change(before, "update"); assert.equal(stale.error?.code, "40001");
    assert.equal((await participant("001")).team, "Cambio concurrente");
  });
  await check("individual DNF and clearing DNF work through the web form and public standing", async () => {
    let person = await participant("201");
    assert.ok((await changeForm(person, "dnf")).searchParams.has("ok"));
    assert.equal((await result("201")).result_status, "DNF");
    const standing = unwrap(await anon.rpc("get_public_event_standing", { p_event_slug: slug }));
    assert.equal(standing.find((p) => p.bib === "201").result_status, "DNF");
    person = await participant("201");
    assert.ok((await changeForm(person, "clear_dnf")).searchParams.has("ok"));
    assert.equal((await result("201")).result_status, "EN CARRERA");
    assert.ok((await changes()).some((a) => a.action === "dnf_cleared"));
  });
  await check("mixed elapsed/clock batch saves via actual Server Action with millisecond precision", async () => {
    const inputs = [elapsed("001", "10:00.250"), elapsed("002", "11:00.250"), elapsed("003", "12:00.250"), elapsed("004", "12:00.250"), elapsed("005", "14:00.250"), elapsed("006", "15:00.250"),
      ...["101", "102", "103", "104"].map((bib, i) => clock(bib, `2026-11-22T09:${20 + i}:00.375`))];
    const redirect = await batchForm(inputs);
    assert.ok(redirect.searchParams.has("ok"), redirect.searchParams.get("error")); assert.ok(redirect.searchParams.get("batch_saved"));
    const current = await results();
    assert.equal(current.filter((p) => p.result_status === "FINALIZÓ").length, 10);
    assert.equal(Number(current.find((p) => p.bib === "001").elapsed_seconds), 600.25);
    assert.equal(Date.parse(current.find((p) => p.bib === "101").finish_at), Date.parse("2026-11-22T12:20:00.375Z"));
    assert.equal((await audit()).filter((a) => a.stage === "finish" && a.reason.includes("planilla manual")).length, 10);
  });
  await check("podiums use live ranks, ties, both distances/sexes and age exclusion replacements", async () => {
    const policy = unwrap(await owner.client.from("event_distances").select("*").eq("event_id", event.id));
    const groups = buildPodiumGroups(await results(), policy);
    assert.equal(groups.length, 4);
    assert.ok(groups.every((group) => ["General","Categoría"].includes(group.type)));
    const male = groups.filter((g) => g.distance === "10KM");
    assert.deepEqual(male.find((g) => g.type === "General").rows.map((r) => r.place), [1, 2, 3, 3]);
    assert.deepEqual(male.find((g) => g.type === "Categoría").rows.map((r) => r.bib), ["005", "006"]);
    assert.ok(groups.some((g) => g.distance === "5KM" && g.sex === "Damas"));
  });
  await check("missing criteria are explicit; filling fields classifies and promotes consistently in SQL, public standing and PDF", async () => {
    const target = unwrap(await owner.client.from("events").insert({ owner_id:owner.id,name:"QA local · Exclusión de categorías",slug:"qa-tools-"+randomUUID(),event_date:"2026-11-22",timezone:"America/Santiago",status:"open" }).select().single());
    unwrap(await owner.client.from("event_distances").insert({ event_id:target.id,distance:"10KM",award_policy_configured:true,exclude_general_top3_from_categories:true }));
    const inputs = [["200",5400,"30 a 39 años"],["201",7200,"30 a 39 años"],["210",7270,"50 a 59 años"],["211",7272,"50 a 59 años"],["212",7275,"50 a 59 años"]];
    const roster = unwrap(await owner.client.from("event_participants").insert(inputs.map(([bib,,bracket]) => ({ event_id:target.id,bib,chip:"QA"+bib,first_name:"Prueba",last_name:"Categoría "+bib,sex:"F",distance:"10KM",category:"Damas · "+bracket,age_bracket:null }))).select());
    const start = "2026-11-22T12:00:00.000Z";
    unwrap(await owner.client.rpc("record_distance_start_manually",{ p_event_id:target.id,p_distance:"10KM",p_captured_at:start,p_reason:"Prueba de exclusión",p_confirm_replace:false }));
    for (const [bib,seconds] of inputs) unwrap(await owner.client.rpc("record_manual_entry",{ p_event_id:target.id,p_participant_id:roster.find((p) => p.bib===bib).id,p_stage:"finish",p_captured_at:new Date(Date.parse(start)+seconds*1000).toISOString(),p_reason:"Llegada de prueba de categoría" }));
    const getResults = async () => unwrap(await owner.client.from("event_results").select("*").eq("event_id",target.id));
    let ranked = await getResults();
    assert.ok(ranked.every(p=>p.category_place===null && p.category===null));
    for(const [bib,,bracket] of inputs) unwrap(await owner.client.from("event_participants").update({age_bracket:bracket}).eq("event_id",target.id).eq("bib",bib));
    ranked=await getResults();
    for (const bib of ["200","201","210"]) assert.equal(ranked.find((p) => p.bib===bib).category_place,null);
    assert.equal(Number(ranked.find((p) => p.bib==="211").category_place),1);
    assert.equal(Number(ranked.find((p) => p.bib==="212").category_place),2);
    const publicRows = unwrap(await anon.rpc("get_public_event_standing",{ p_event_slug:target.slug }));
    assert.equal(publicRows.find((p) => p.bib==="210").category_place,null);
    assert.equal(Number(publicRows.find((p) => p.bib==="211").category_place),1);
    const pdf = Buffer.from(await (await fetch(`${appUrl}/admin/events/${target.id}/podiums`,{ headers:{ Cookie:owner.cookie() } })).arrayBuffer()).toString("latin1");
    for (const bib of ["200","201","210"]) assert.equal(pdf.split(`<${Buffer.from(bib).toString("hex")}> Tj`).length-1,1,`General winner ${bib} repeated in category PDF`);
    for (const bib of ["211","212"]) assert.ok(pdf.includes(`<${Buffer.from(bib).toString("hex")}> Tj`));
    unwrap(await owner.client.from("event_distances").update({ exclude_general_top3_from_categories:false }).eq("event_id",target.id));
    ranked=await getResults();
    assert.equal(Number(ranked.find((p) => p.bib==="200").category_place),1);
    assert.equal(Number(ranked.find((p) => p.bib==="210").category_place),1);
    const allowedPublic = unwrap(await anon.rpc("get_public_event_standing",{ p_event_slug:target.slug }));
    assert.equal(Number(allowedPublic.find((p) => p.bib==="210").category_place),1);
    const groups=buildPodiumGroups(ranked,[{ distance:"10KM",award_policy_configured:true,exclude_general_top3_from_categories:false }]);
    assert.ok(groups.some((g) => g.type!=="General"&&g.rows.some((r) => r.bib==="210")));
  });
  await check("PDF route downloads complete report and rejects anonymous/other-owner access", async () => {
    const endpoint = `${appUrl}/admin/events/${event.id}/podiums`;
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers: { Cookie: outsider.cookie() } })).status, 404);
    const response = await fetch(endpoint, { headers: { Cookie: owner.cookie() } });
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /application\/pdf/);
    assert.match(response.headers.get("content-disposition"), /attachment.*podios\.pdf/);
    const body = Buffer.from(await response.arrayBuffer()); assert.equal(body.subarray(0, 8).toString(), "%PDF-1.4");
    assert.ok(!body.toString("latin1").includes(Buffer.from("12.345.678-5").toString("hex")), "A RUT in the team field must not leak into the PDF");
    assert.equal((await participant("005")).team, "12.345.678-5", "Export redaction must preserve the source roster");
    fs.writeFileSync(path.join(output, "podios-integracion.pdf"), body);
  });
  await check("correcting an existing finish preserves before/after values in audit", async () => {
    const before = await result("001");
    assert.ok((await batchForm([elapsed("001", "10:01.250")])).searchParams.has("ok"));
    const correction = (await audit()).find((a) => a.participant_id === before.participant_id && a.stage === "finish" && a.action === "manual_corrected");
    assert.equal(Date.parse(correction.before_entry.captured_at), Date.parse(before.finish_at));
    assert.equal(Number((await result("001")).elapsed_seconds), 601.25);
  });
  await check("a finisher requires special DNF confirmation and clearing it restores preserved marks/ranks", async () => {
    const person = await participant("001");
    const before = await result("001");
    const marks = () => owner.client.from("timing_entries").select("*").eq("event_id", event.id).eq("participant_id", person.id).order("stage");
    const originalMarks = unwrap(await marks());
    const originalAuditCount = (await audit()).length;
    // Prime the public snapshot so this also verifies DNF cache invalidation.
    const previous = unwrap(await anon.rpc("get_public_event_standing", { p_event_slug: slug }));
    assert.equal(Number(previous.find((p) => p.bib === "001").overall_place), 1);
    const initialPublicHtml = await (await fetch(`${appUrl}/e/${slug}`)).text();
    const publicRow = (html) => html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)?.find((row) => row.includes("José María"));
    assert.ok(publicRow(initialPublicHtml)?.includes("00:10:01"));
    const confirmation = { confirm_finished_dnf: true, expected_finish_at: before.finish_at };
    assert.equal((await change(person, "dnf")).error?.code, "22023");
    assert.equal((await change(person, "dnf", { ...confirmation, confirm_finished_dnf: "true" })).error?.code, "22023");
    assert.equal((await change(person, "dnf", { ...confirmation, expected_finish_at: "2026-11-22T12:00:01Z" })).error?.code, "40001");
    assert.equal((await change(person, "dnf", confirmation, outsider.client)).error?.code, "42501");
    const missing = await changeForm(person, "dnf", { expected_finish_at: before.finish_at });
    assert.match(missing.searchParams.get("error"), /Confirma/);
    const blankReason = await changeForm(person, "dnf", { expected_finish_at: before.finish_at, confirm_finished_dnf: "on", reason: " " });
    assert.ok(blankReason.searchParams.has("error"));
    const stale = await changeForm(person, "dnf", { expected_finish_at: "2026-11-22T12:00:01Z", confirm_finished_dnf: "on" });
    assert.match(stale.searchParams.get("error"), /cambió/);
    assert.equal((await participant("001")).dnf_at, null);
    assert.deepEqual(unwrap(await marks()), originalMarks);
    const confirmed = await changeForm(person, "dnf", { expected_finish_at: before.finish_at, confirm_finished_dnf: "on", reason: "El corredor informó que no completó el recorrido" });
    assert.ok(confirmed.searchParams.has("ok"), confirmed.searchParams.get("error"));
    const dnf = await result("001");
    assert.equal(dnf.result_status, "DNF"); assert.equal(dnf.overall_place, null); assert.equal(dnf.category_place, null);
    assert.equal(dnf.start_at, before.start_at); assert.equal(dnf.finish_at, before.finish_at); assert.equal(dnf.elapsed_seconds, before.elapsed_seconds);
    assert.deepEqual(unwrap(await marks()), originalMarks);
    assert.equal((await audit()).length, originalAuditCount, "DNF must not void or replace a timing entry");
    const changed = (await changes()).find((a) => a.participant_id === person.id && a.action === "dnf_marked");
    assert.equal(changed.timing_snapshot.length, 2); assert.ok(changed.before_values.dnf_at === null && changed.after_values.dnf_at);
    const standing = unwrap(await anon.rpc("get_public_event_standing", { p_event_slug: slug }));
    assert.equal(standing.find((p) => p.bib === "001").result_status, "DNF");
    assert.equal(standing.find((p) => p.bib === "001").overall_place, null);
    assert.equal(Number(standing.find((p) => p.bib === "002").overall_place), 1);
    const dnfPublicRow = publicRow(await (await fetch(`${appUrl}/e/${slug}`)).text());
    assert.ok(dnfPublicRow?.includes(">DNF</span>"), "The public page cache must reflect the DNF immediately");
    assert.ok(!dnfPublicRow.includes("00:10:01"), "DNF must not display an official finishing time");
    const current = await results();
    const policies = unwrap(await owner.client.from("event_distances").select("*").eq("event_id", event.id));
    assert.ok(buildPodiumGroups(current, policies).every((group) => group.rows.every((row) => row.bib !== "001")));
    const html = await (await fetch(`${appUrl}/admin/events/${event.id}`, { headers: { Cookie: owner.cookie() } })).text();
    const resultsSection = html.match(/<section\b[^>]*id="resultados"[^>]*>[\s\S]*?<\/section>/)?.[0];
    assert.ok(resultsSection && !resultsSection.includes("José María"), "DNF with marks must not remain in completed results");
    const pdf = Buffer.from(await (await fetch(`${appUrl}/admin/events/${event.id}/podiums`, { headers: { Cookie: owner.cookie() } })).arrayBuffer()).toString("latin1");
    assert.ok(!pdf.includes(Buffer.from("José María Muñoz 001", "latin1").toString("hex")));
    const restored = await changeForm(await participant("001"), "clear_dnf");
    assert.ok(restored.searchParams.has("ok"), restored.searchParams.get("error"));
    const after = await result("001");
    assert.equal(after.result_status, "FINALIZÓ"); assert.equal(Number(after.overall_place), 1);
    assert.equal(after.finish_at, before.finish_at); assert.deepEqual(unwrap(await marks()), originalMarks);
    const restoredStanding = unwrap(await anon.rpc("get_public_event_standing", { p_event_slug: slug }));
    assert.equal(restoredStanding.find((p) => p.bib === "001").result_status, "FINALIZÓ");
    assert.equal(Number(restoredStanding.find((p) => p.bib === "001").overall_place), 1);
    const restoredPublicRow = publicRow(await (await fetch(`${appUrl}/e/${slug}`)).text());
    assert.ok(restoredPublicRow?.includes(">FINALIZÓ</span>"));
    assert.ok(restoredPublicRow.includes("00:10:01"));
  });
  await check("database batch is atomic when a later row fails optimistic concurrency", async () => {
    const rows = await prepare([elapsed("205", "25:00"), elapsed("206", "26:00")]);
    rows[1].expected_finish_at = "2026-11-22T12:00:01Z";
    const beforeAudit = (await audit()).length;
    const failure = await owner.client.rpc("record_manual_finishes_batch", { p_event_id: event.id, p_rows: rows });
    assert.equal(failure.error?.code, "40001");
    assert.equal((await result("205")).finish_at, null); assert.equal((await result("206")).finish_at, null);
    assert.equal((await audit()).length, beforeAudit);
  });
  await check("batch rejects duplicate runners, DNF and missing starts without partial writes", async () => {
    const [row] = await prepare([elapsed("205", "25:00")]);
    assert.equal((await owner.client.rpc("record_manual_finishes_batch", { p_event_id: event.id, p_rows: [row, row] })).error?.code, "22023");
    const dnf = await participant("201"); unwrap(await change(dnf, "dnf"));
    const dnfResult = await result("201");
    const crafted = { ...row, bib: "201", participant_id: dnf.id, expected_start_at: dnfResult.start_at, expected_finish_at: null };
    assert.equal((await owner.client.rpc("record_manual_finishes_batch", { p_event_id: event.id, p_rows: [crafted] })).error?.code, "22023");
    const missing = { ...row, bib: "203", participant_id: noStart.id, expected_start_at: null };
    assert.equal((await owner.client.rpc("record_manual_finishes_batch", { p_event_id: event.id, p_rows: [missing] })).error?.code, "40001");
    assert.equal((await result("205")).finish_at, null);
    assert.equal((await change(await participant("001"), "dnf")).error?.code, "22023");
  });
  await check("web action rejects a changed start and supports next-day clock input", async () => {
    const inputs = [elapsed("204", "30:00")]; const rows = await prepare(inputs);
    unwrap(await owner.client.rpc("record_manual_entry", { p_event_id: event.id, p_participant_id: rows[0].participant_id, p_stage: "start", p_captured_at: "2026-11-22T12:00:01.125Z", p_reason: "Cambio concurrente de salida" }));
    const stale = await batchForm(inputs, rows); assert.match(stale.searchParams.get("error"), /cambiaron/);
    assert.equal((await result("204")).finish_at, null);
    const nextDay = await batchForm([clock("205", "2026-11-23T00:10:00.500")]);
    assert.ok(nextDay.searchParams.has("ok"), nextDay.searchParams.get("error"));
    assert.equal(Date.parse((await result("205")).finish_at), Date.parse("2026-11-23T03:10:00.500Z"));
  });
  await check("withdrawal removes active runner/results and preserves marks/history/roster provenance", async () => {
    const person = await participant("202");
    unwrap(await owner.client.rpc("record_manual_entry", { p_event_id: event.id, p_participant_id: person.id, p_stage: "finish", p_captured_at: "2026-11-22T12:40:00Z", p_reason: "Llegada previa a baja QA" }));
    assert.ok((await changeForm(person, "remove")).searchParams.has("ok"));
    assert.equal(unwrap(await owner.client.from("event_participants").select("id").eq("id", person.id)).length, 0);
    assert.ok(!(await results()).some((p) => p.participant_id === person.id));
    const archived = (await changes()).find((a) => a.action === "removed" && a.participant_id === person.id);
    assert.equal(archived.before_values.bib, "202"); assert.equal(archived.timing_snapshot.length, 2); assert.ok(archived.timing_audit_snapshot.length >= 2);
    const revision = unwrap(await owner.client.from("event_roster_revision_rows").select("participant_id,after_values").eq("event_id", event.id)).find((r) => r.after_values?.bib === "202");
    assert.ok(revision); assert.equal(revision.participant_id, null); assert.equal(revision.after_values.id, person.id);
    const publicRows = unwrap(await anon.rpc("get_public_event_standing", { p_event_slug: slug }));
    assert.ok(!publicRows.some((p) => p.bib === "202"));
  });
  await check("RLS and both RPCs prevent access by another owner or anonymous callers", async () => {
    const person = await participant("001");
    assert.equal((await change(person, "update", valueFields(person), outsider.client)).error?.code, "42501");
    assert.equal((await change(person, "update", valueFields(person), anon)).error?.code, "42501");
    assert.equal(unwrap(await outsider.client.from("participant_change_audit").select("id").eq("event_id", event.id)).length, 0);
    const row = (await prepare([elapsed("206", "26:00")]))[0];
    assert.equal((await outsider.client.rpc("record_manual_finishes_batch", { p_event_id: event.id, p_rows: [row] })).error?.code, "42501");
    assert.equal((await anon.rpc("record_manual_finishes_batch", { p_event_id: event.id, p_rows: [row] })).error?.code, "42501");
    const unauth = await fetch(`${appUrl}/admin/events/${event.id}`, { redirect: "manual" }); assert.ok([303, 307].includes(unauth.status));
  });

  await check("criteria produce identical SQL, PDF and offline ranks despite names, edits and ties", async()=>{
    const target=unwrap(await owner.client.from("events").insert({owner_id:owner.id,name:"QA matrices sintéticas",slug:"qa-tools-"+randomUUID(),event_date:"2026-11-23",status:"open"}).select().single());
    unwrap(await owner.client.from("event_distances").insert(["10KM","5KM"].map(distance=>({event_id:target.id,distance,award_policy_configured:true}))));
    const roster=unwrap(await owner.client.from("event_participants").insert(Array.from({length:12},(_,i)=>({event_id:target.id,bib:"S"+i,chip:"SYN"+i,first_name:"Sintético "+i,distance:i===11?"5KM":"10KM",sex:i===10?null:i===9?"F":"M",age_bracket:i===8?null:i===7?"40–49":i%2?"30-39":"30 a 39 años",category:i%2?"Categoría histórica A":"Categoría histórica B"}))).select());
    for(const distance of ["10KM","5KM"]) unwrap(await owner.client.rpc("record_distance_start_manually",{p_event_id:target.id,p_distance:distance,p_captured_at:"2026-11-23T12:00:00Z",p_reason:"Salida sintética",p_confirm_replace:false}));
    for(let i=0;i<roster.length;i++) unwrap(await owner.client.rpc("record_manual_entry",{p_event_id:target.id,p_participant_id:roster[i].id,p_stage:"finish",p_captured_at:new Date(Date.parse("2026-11-23T12:00:00Z")+[10,20,30,30,50,60,70,80,90,100,110,120][i]*1000).toISOString(),p_reason:"Llegada sintética"}));
    const verify=async(excluded)=>{
      const rows=unwrap(await owner.client.from("event_results").select("*").eq("event_id",target.id));
      const bridge=JSON.parse(execFileSync("dotnet",[path.resolve(__dirname,"../../RFIDLocal/bin/CriteriaQA/CriteriaBridge.dll")],{input:JSON.stringify({participants:rows,exclusionDistances:excluded}),encoding:"utf8",windowsHide:true}));
      for(const row of rows){const local=bridge.find(p=>p.participant_id===row.participant_id);assert.equal(local.category,row.category);assert.equal(local.category_place,row.category_place);assert.equal(local.overall_place,row.overall_place);assert.equal(local.status,row.result_status);}
      const groups=buildPodiumGroups(rows,[]); for(const group of groups)for(const p of group.rows){const official=rows.find(r=>r.bib===p.bib);assert.equal(p.place,group.type==="General"?official.overall_place:official.category_place);}
      return rows;
    };
    const before=await verify([]);assert.equal(new Set(before.filter(r=>r.sex==="M"&&r.age_bracket==="30 a 39 años"&&r.distance==="10KM").map(r=>r.category_key)).size,1);
    const renamed=roster[0];unwrap(await owner.client.from("event_participants").update({category:"Otro nombre completamente distinto"}).eq("id",renamed.id));
    const after=await verify([]);assert.deepEqual(after.map(r=>[r.participant_id,r.category_place]).sort(),before.map(r=>[r.participant_id,r.category_place]).sort());
    const reviewed=unwrap(await owner.client.from("event_participants").select("*").eq("id",renamed.id).single());
    const edited=await formAction("changeParticipantAction",{event_id:target.id,participant_id:reviewed.id,operation:"update",expected:JSON.stringify(expected(reviewed)),...valueFields(reviewed),age_bracket:"40-49",reason:"Reclasificar después de llegada"});assert.ok(edited.searchParams.has("ok"),edited.searchParams.get("error"));
    const changed=await verify([]);assert.equal(changed.find(r=>r.participant_id===reviewed.id).finish_at,before.find(r=>r.participant_id===reviewed.id).finish_at);
    unwrap(await owner.client.from("event_distances").update({exclude_general_top3_from_categories:true}).eq("event_id",target.id));const excluded=await verify(["10KM","5KM"]);
    assert.ok(excluded.filter(r=>r.overall_place<=3).every(r=>r.category_place===null));
    const publicRows=unwrap(await anon.rpc("get_public_event_standing",{p_event_slug:target.slug}));for(const row of excluded)assert.equal(publicRows.find(p=>p.bib===row.bib).category_place,row.category_place);
    assert.equal((await owner.client.from("event_distances").update({category_criteria:["sex","circuit","age_bracket"]}).eq("event_id",target.id)).error?.code,"23514");
  });
  await check("D07 publishes the offline criteria snapshot and rejects old or mismatching policies atomically",async()=>{
    const {packageHash}=require("../lib/d07-transfer.ts");
    const eventId=randomUUID(),start="2026-11-23T12:00:00.000Z";
    const participants=Array.from({length:6},(_,i)=>({id:randomUUID(),bib:"D"+i,chip:"SYN-D"+i,first_name:"Intercambio",last_name:"Sintético "+i,distance:"10KM",sex:"F",age_bracket:i%2?"30-39":"30 a 39 años",category:i%2?"Nombre A":"Nombre B"}));
    const rows=participants.map((p,i)=>({...p,participant_id:p.id,start_at:start,finish_at:new Date(Date.parse(start)+(100+i)*1000).toISOString(),result_status:"FINALIZÓ"}));
    const offline=JSON.parse(execFileSync("dotnet",[path.resolve(__dirname,"../../RFIDLocal/bin/CriteriaQA/CriteriaBridge.dll")],{input:JSON.stringify({participants:rows,exclusionDistances:["10KM"]}),encoding:"utf8",windowsHide:true}));
    const pkg={format:"yr-event-transfer",version:1,kind:"publication",manifest:{transfer_id:randomUUID(),revision:1,source_revision:"synthetic-1"},event:{id:eventId,name:"Intercambio sintético",minimum_rssi:-70,event_date:"2026-11-23",timezone:"America/Santiago",status:"open"},policy:{preset_id:"category_criteria_v1",revision:"1"},distances:[{distance:"10KM",award_policy_configured:true,exclude_general_top3_from_categories:true,category_criteria:["sex","age_bracket"],category_policy_version:"category_criteria_v1"}],participants,marks:rows.flatMap(p=>["start","finish"].map(stage=>({participant_id:p.id,stage,captured_at:p[stage+"_at"],origin:"manual"}))),operations:[],receipts:[],history:[],expected_results:rows.map(p=>({participant_id:p.id,status:"FINALIZÓ",start_at:p.start_at,finish_at:p.finish_at,overall_place:offline.find(r=>r.participant_id===p.id).overall_place,category_place:offline.find(r=>r.participant_id===p.id).category_place}))};
    const send=async p=>owner.client.rpc("apply_event_transfer",{p_package:{...p,sha256:packageHash(p)},p_mode:"commit",p_final:false,p_target_event_id:null});
    assert.equal((await send({...pkg,policy:{preset_id:"compat_actual_v1",revision:"1"}})).error?.code,"22023");
    const wrong=structuredClone(pkg);wrong.expected_results[4].category_place=99;assert.equal((await send(wrong)).error?.code,"40001");
    assert.equal(unwrap(await owner.client.from("events").select("id").eq("id",eventId)).length,0,"Mismatch must roll back entire event");
    unwrap(await send(pkg));const published=unwrap(await owner.client.from("event_results").select("*").eq("event_id",eventId));assert.equal(published.length,6);
    for(const p of published)assert.equal(p.category_place,offline.find(r=>r.participant_id===p.participant_id).category_place);
  });
  await check("5000-row web batch and paginated PDF export complete without truncation", async () => {
    const large = unwrap(await owner.client.from("events").insert({ owner_id: owner.id, name: "QA local · 5000 llegadas", slug: "qa-tools-" + randomUUID(), timezone: "America/Santiago", event_date: "2026-11-22", status: "open" }).select().single());
    unwrap(await owner.client.from("event_distances").insert({ event_id: large.id, distance: "10KM", award_policy_configured: true, exclude_general_top3_from_categories: true }));
    const people = Array.from({ length: 5000 }, (_, index) => ({ id: randomUUID(), event_id: large.id, bib: "B" + String(index + 1).padStart(5, "0"), chip: "LOAD" + String(index + 1), first_name: "Prueba masiva", last_name: String(index + 1), sex: "M", distance: "10KM", category: "10KM Varones · 30 a 39 años", age_bracket: "30 a 39 años", age: 35 }));
    for (let offset = 0; offset < people.length; offset += 500) unwrap(await owner.client.from("event_participants").insert(people.slice(offset, offset + 500)));
    // Seed the large fixture in one statement; this test measures finish batches,
    // not the unrelated per-participant official-start RPC and its HTTP timeout.
    assert.match(large.id, /^[0-9a-f-]{36}$/);
    assert.match(owner.id, /^[0-9a-f-]{36}$/);
    sql(`insert into public.timing_entries(event_id,participant_id,stage,captured_at,origin,operator_id)
      select event_id,id,'start','2026-11-22T12:00:00.125Z'::timestamptz,'manual','${owner.id}'::uuid
      from public.event_participants where event_id='${large.id}'::uuid;
      update public.event_distances set started_at='2026-11-22T12:00:00.125Z' where event_id='${large.id}'::uuid;`);
    const start = unwrap(await owner.client.from("event_results").select("start_at").eq("event_id", large.id).limit(1).single()).start_at;
    const rows = people.map((person, index) => ({ participant_id: person.id, expected_start_at: start, expected_finish_at: null, input: elapsed(person.bib, `${Math.floor((100 + index) / 60)}:${String((100 + index) % 60).padStart(2, "0")}.250`) }));
    const redirect = await formAction("recordManualFinishesBatchAction", { event_id: large.id, rows: JSON.stringify(rows), reason: "Prueba masiva de 5000 llegadas" });
    assert.ok(redirect.searchParams.has("ok"), redirect.searchParams.get("error"));
    const countStarted=performance.now();
    const count = await owner.client.from("event_results").select("participant_id", { count: "exact", head: true }).eq("event_id", large.id).eq("result_status", "FINALIZÓ");
    report.count5000Milliseconds=Math.round(performance.now()-countStarted);
    unwrap(count); assert.equal(count.count, 5000);
    const finishAudits = await owner.client.from("timing_entry_audit").select("id", { count: "exact", head: true }).eq("event_id", large.id).eq("stage", "finish");
    unwrap(finishAudits); assert.equal(finishAudits.count, 5000);
    const response = await fetch(`${appUrl}/admin/events/${large.id}/podiums`, { headers: { Cookie: owner.cookie() } });
    assert.equal(response.status, 200);
    const pdf = Buffer.from(await response.arrayBuffer());
    const source = pdf.toString("latin1");
    for (const bib of ["B00001", "B00002", "B00003", "B00004", "B00005", "B00006"]) assert.ok(source.includes(Buffer.from(bib).toString("hex")), `Missing podium winner ${bib}`);
    fs.writeFileSync(path.join(output, "podios-5000-llegadas.pdf"), pdf);
  });
  await check("started distance and local authority guards remain effective", async () => {
    const person = await participant("206");
    assert.equal((await change(person, "update", { ...valueFields(person), distance: "5KM" })).error?.code, "23514");
    const row = (await prepare([elapsed("206", "26:00")]))[0];
    unwrap(await owner.client.from("events").update({ local_operation_status: "prepared" }).eq("id", event.id));
    assert.equal((await change(person, "update")).error?.code, "55000");
    assert.equal((await owner.client.rpc("record_manual_finishes_batch", { p_event_id: event.id, p_rows: [row] })).error?.code, "55000");
  });
});
