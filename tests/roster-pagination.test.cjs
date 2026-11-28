/* eslint-disable @typescript-eslint/no-require-imports -- Native Node tests match the existing test runner. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const { createClient } = require("@supabase/supabase-js");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);
const { parseRosterFilters, rosterCategoryOptions, rosterPageHref, fetchRosterPage } = require("../lib/roster-pagination.ts");

const eventId = "00000000-0000-4000-8000-000000000001";
const defaults = () => parseRosterFilters({});
const person = (index, patch = {}) => ({
  id: String(index).padStart(6, "0"), event_id: eventId, bib: String(index).padStart(4, "0"),
  chip: `EPC${index}`, sex: index % 2 ? "F" : "M", distance: "10KM", age_bracket: "30 a 39 años", ...patch,
});

// Use the real Supabase client and inspect its HTTP contract; no database is written.
function database({ count = 120, ids = [], fail = null } = {}) {
  const requests = [];
  const client = createClient("http://127.0.0.1:54321", "synthetic-public-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(input);
      requests.push({ url, method: init.method, headers: new Headers(init.headers) });
      assert.equal(url.pathname, "/rest/v1/event_participants");
      assert.ok(["GET", "HEAD"].includes(init.method));
      assert.equal(url.searchParams.get("event_id"), `eq.${eventId}`);
      assert.equal(url.searchParams.get("select"), "id");
      if (fail === init.method) return new Response(JSON.stringify({ message: "Simulated read failure", code: "XX000" }), { status: 500 });
      return new Response(init.method === "HEAD" ? null : JSON.stringify(ids.map((id) => ({ id }))), {
        status: 200, headers: { "content-type": "application/json", "content-range": `0-49/${count}` },
      });
    } },
  });
  return { client, requests };
}

test("filters accept only the roster fields, preserve leading zeros and normalize chip whitespace", () => {
  const filters = parseRosterFilters({ roster_bib: [" 0042 ", "ignored"], roster_chip: " e2 00 ", roster_page: "2", name: "ignored" });
  assert.deepEqual(filters, { ...defaults(), bib: "0042", chip: "e200", page: 2 });
  for (const page of ["-1", "0", "1.5", "NaN", "99999999999999999999"]) assert.equal(parseRosterFilters({ roster_page: page }).page, 1);
});

test("category options use the displayed criteria and retain equivalent legacy brackets", () => {
  const options = rosterCategoryOptions([
    person(1, { category: "Texto original A", age_bracket: "30-39" }),
    person(3, { category: "Texto original B" }),
    person(2), person(4, { sex: "no_informado" }), person(5, { age_bracket: "35" }),
  ]);
  assert.equal(options.length, 2);
  const female = options.find((option) => option.sex === "F");
  assert.equal(female.value, '["F","30 a 39 años"]');
  assert.equal(female.label, "Damas · 30 a 39 años");
  assert.deepEqual(female.ageBrackets, ["30-39", "30 a 39 años"]);
});

test("page 2 fetches only 50 IDs with stable ordering and an exact count", async () => {
  const db = database({ ids: Array.from({ length: 50 }, (_, index) => person(index + 51).id) });
  const result = await fetchRosterPage(db.client, eventId, { ...defaults(), page: 2 }, []);
  assert.equal(result.ids.length, 50);
  assert.equal(result.count, 120);
  assert.equal(result.pages, 3);
  assert.equal(result.page, 2);
  assert.equal(result.error, null);
  assert.equal(db.requests.length, 2);
  assert.equal(db.requests[0].method, "HEAD");
  assert.ok(db.requests[0].headers.get("prefer").includes("count=exact"));
  const query = db.requests[1].url.searchParams;
  assert.equal(query.get("offset"), "50");
  assert.equal(query.get("limit"), "50");
  assert.equal(query.get("order"), "bib.asc.nullslast,id.asc");
});

test("all filters apply to both count and page, without treating original category text as identity", async () => {
  const categories = rosterCategoryOptions([person(1, { age_bracket: "30-39" }), person(3)]);
  const db = database({ count: 2, ids: [person(1).id, person(3).id] });
  const filters = { ...defaults(), bib: "00", chip: "EPC", sex: "F", distance: "10KM", category: categories[0].value };
  await fetchRosterPage(db.client, eventId, filters, categories);
  for (const request of db.requests) {
    const query = request.url.searchParams;
    assert.equal(query.get("bib"), "ilike.%00%");
    assert.equal(query.get("chip"), "ilike.%EPC%");
    assert.equal(query.get("sex"), "eq.F");
    assert.equal(query.get("distance"), "in.(10KM)");
    assert.equal(query.get("age_bracket"), 'in.(30-39,30 a 39 años)');
    assert.equal(query.get("category"), null);
    assert.equal(query.get("or"), null);
  }
});

test("identifier punctuation cannot inject other filters; percent and underscore match literally", async () => {
  const db = database();
  await fetchRosterPage(db.client, eventId, { ...defaults(), bib: '00%,chip.eq.any_\\"' }, []);
  const params = db.requests[0].url.searchParams;
  assert.equal(params.get("bib"), 'ilike.%00\\%,chip.eq.any\\_\\\\"%');
  assert.equal(params.get("chip"), null);
  assert.equal(params.get("or"), null);
});

test("distance filters include legacy spellings without rewriting stored values", async () => {
  const db = database();
  await fetchRosterPage(db.client, eventId, { ...defaults(), distance: "10KM" }, [], ["10 KM", "10KM", "5KM"]);
  assert.equal(db.requests[0].url.searchParams.get("distance"), "in.(10KM,10 KM)");
});

test("stale pages clamp to the last page and empty matches never request an invalid range", async () => {
  const db = database({ count: 51, ids: [person(51).id] });
  const result = await fetchRosterPage(db.client, eventId, { ...defaults(), page: Number.MAX_SAFE_INTEGER }, []);
  assert.equal(result.page, 2);
  assert.equal(db.requests[1].url.searchParams.get("offset"), "50");
  const noMatches = database({ count: 0 });
  assert.deepEqual(await fetchRosterPage(noMatches.client, eventId, defaults(), []), { ids: [], count: 0, page: 1, pages: 1, error: null });
  assert.equal(noMatches.requests.length, 1);
});

test("unknown or contradictory categories give no matches instead of dropping a filter", async () => {
  const categories = rosterCategoryOptions([person(1)]);
  for (const filters of [{ ...defaults(), category: "obsolete" }, { ...defaults(), sex: "M", category: categories[0].value }]) {
    const db = database();
    const result = await fetchRosterPage(db.client, eventId, filters, categories);
    assert.equal(result.count, 0);
    assert.equal(db.requests.length, 0);
  }
});

test("missing sex remains distinguishable from explicitly not informed", async () => {
  for (const sex of ["unspecified", "no_informado"]) {
    const db = database();
    await fetchRosterPage(db.client, eventId, { ...defaults(), sex }, []);
    assert.equal(db.requests[0].url.searchParams.get("sex"), sex === "unspecified" ? "is.null" : "eq.no_informado");
  }
});

test("read errors are surfaced rather than shown as an empty roster", async () => {
  for (const fail of ["HEAD", "GET"]) {
    const db = database({ fail });
    const result = await fetchRosterPage(db.client, eventId, defaults(), []);
    assert.equal(result.error.message, "Simulated read failure");
    assert.equal(db.requests.length, fail === "HEAD" ? 1 : 2);
  }
});

test("pagination URLs preserve filters, escape values and do not replay mutation notices", () => {
  const filters = { ...defaults(), bib: '0&tab=settings', chip: "E2+00", sex: "F", distance: "10KM", category: '["F","30 a 39 años"]' };
  const url = new URL(rosterPageHref(eventId, filters, 3), "https://example.test");
  assert.equal(url.searchParams.get("tab"), "roster");
  assert.equal(url.searchParams.get("roster_page"), "3");
  assert.equal(url.searchParams.get("roster_bib"), filters.bib);
  assert.equal(url.searchParams.get("roster_chip"), filters.chip);
  assert.equal(url.searchParams.get("roster_category"), filters.category);
  assert.equal(url.searchParams.get("ok"), null);
  assert.equal(new URL(rosterPageHref(eventId, filters, 1), url).searchParams.get("roster_page"), null);
});

test("the actual event page renders at most 50 editors and preserves global data for results and imports", async (t) => {
  const Module = require("node:module");
  const path = require("node:path");
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const root = path.resolve(__dirname, "..");
  const originalLoad = Module._load;
  const originalTs = require.extensions[".ts"];
  const originalTsx = require.extensions[".tsx"];
  let tables, captured;
  const action = async () => { throw new Error("Rendering must not call a write action"); };
  const actions = new Proxy({ __esModule: true }, { get: (object, key) => key in object ? object[key] : action });
  function query(table) {
    const criteria = [], orders = [];
    let head = false, single = false, start = 0, end = Infinity;
    const result = () => {
      let rows = [...(tables[table] ?? [])].filter((row) => criteria.every((predicate) => predicate(row)));
      const count = rows.length;
      rows.sort((a, b) => {
        for (const field of orders) {
          if (a[field] === b[field]) continue;
          if (a[field] == null) return 1;
          if (b[field] == null) return -1;
          return String(a[field]).localeCompare(String(b[field]));
        }
        return 0;
      });
      rows = rows.slice(start, end + 1);
      return { data: head ? null : single ? rows[0] ?? null : rows, error: null, count };
    };
    const builder = new Proxy({}, { get: (_, method) => {
      if (method === "then") return (resolve, reject) => Promise.resolve(result()).then(resolve, reject);
      return (...args) => {
        if (method === "select") head = args[1]?.head ?? false;
        if (method === "eq") criteria.push((row) => row[args[0]] === args[1]);
        if (method === "in") criteria.push((row) => args[1].includes(row[args[0]]));
        if (method === "is") criteria.push((row) => row[args[0]] === args[1]);
        if (method === "ilike") criteria.push((row) => String(row[args[0]] ?? "").toLowerCase().includes(args[1].slice(1, -1).toLowerCase()));
        if (method === "order") orders.push(args[0]);
        if (method === "range") [start, end] = args;
        if (method === "limit") end = args[0] - 1;
        if (method === "maybeSingle") single = true;
        return builder;
      };
    } });
    return builder;
  }
  const componentNames = new Set(["roster-importer", "admin-results-table", "manual-finishes-grid", "finish-corrections-importer", "participant-picker"]);
  Module._load = function (request, parent, isMain) {
    if (request === "@/app/actions") return actions;
    if (request === "@/lib/supabase/server") return { createClient: async () => ({ from: query, rpc: () => Promise.resolve({ data: null, error: null }) }) };
    if (request === "next/link") return { __esModule: true, default: ({ children, prefetch, scroll, ...props }) => { void prefetch; void scroll; return React.createElement("a", props, children); } };
    if (request === "next/form") return { __esModule: true, default: ({ children, prefetch, scroll, ...props }) => { void prefetch; void scroll; return React.createElement("form", { ...props, method: "get" }, children); } };
    if (request === "next/navigation") return { notFound: () => { throw new Error("Event not found"); } };
    if (request.startsWith("@/")) {
      const name = request.slice("@/components/".length);
      const actual = originalLoad.call(this, path.join(root, request.slice(2)), parent, isMain);
      if (componentNames.has(name)) return { ...actual, __esModule: true, default: (props) => { captured[name] = props; return React.createElement(actual.default, props); } };
      return actual;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  for (const ext of [".ts", ".tsx"]) require.extensions[ext] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
  t.after(() => { Module._load = originalLoad; require.extensions[".ts"] = originalTs; require.extensions[".tsx"] = originalTsx; });
  const Page = require("../app/admin/events/[id]/page.tsx").default;
  async function render(count, marked, params) {
    captured = {};
    const participants = Array.from({ length: count }, (_, i) => ({ ...person(i + 1), first_name: "Sintética", last_name: String(i + 1), rut: null, age: 35, category: "Referencia original", team: null, dnf_at: null }));
    tables = {
      events: [{ id: eventId, slug: "synthetic", name: "Evento sintético", timezone: "America/Santiago", status: "open" }],
      event_distances: [{ event_id: eventId, distance: "10KM", award_policy_configured: true }],
      event_participants: participants,
      event_results: participants.map((p, i) => ({ ...p, participant_id: p.id, start_at: marked ? "2026-11-28T12:00:00Z" : null, finish_at: marked ? "2026-11-28T13:00:00Z" : null, elapsed_seconds: marked ? 3600 : null, overall_place: marked ? i + 1 : null, category_place: marked ? i + 1 : null, result_status: marked ? "FINALIZÓ" : "SIN SALIDA" })),
    };
    const before = JSON.stringify(tables);
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: eventId }), searchParams: Promise.resolve({ tab: "roster", ...params }) }));
    assert.equal(JSON.stringify(tables), before, "Rendering and filtering must not modify participants or results");
    assert.equal(captured["roster-importer"].participants.length, count);
    assert.equal(captured["manual-finishes-grid"].participants.length, count);
    assert.equal(captured["finish-corrections-importer"].participants.length, count);
    assert.equal(captured["participant-picker"].participants.length, count);
    assert.equal(captured["admin-results-table"].participants.length, marked ? count : 0);
    assert.ok(!html.includes("La vista de resultados no coincide"));
    const roster = html.match(/<section[^>]*id="nomina"[\s\S]*?<\/section>/)[0];
    assert.ok(!/^<section[^>]*\shidden/.test(roster), "A direct roster URL must show the roster before hydration");
    return { html, roster };
  }
  const large = await render(5000, false, { roster_page: "2" });
  assert.equal((large.roster.match(/<dialog\b/g) ?? []).length, 50);
  assert.ok(large.roster.includes("Mostrando 51–100 de 5000 participantes"));
  assert.ok(large.roster.includes('value="000051"'));
  assert.ok(!large.roster.includes('value="000001"'));
  assert.ok(Buffer.byteLength(large.roster) < 400_000, "The roster HTML must remain bounded for 5000 participants");
  const last = await render(103, false, { roster_page: "3" });
  assert.equal((last.roster.match(/<dialog\b/g) ?? []).length, 3);
  assert.ok(last.roster.includes("Mostrando 101–103 de 103 participantes"));
  const filtered = await render(103, true, { roster_bib: "0103" });
  assert.equal((filtered.roster.match(/<dialog\b/g) ?? []).length, 1);
  assert.ok(filtered.roster.includes("Mostrando 1–1 de 1 participantes"));
  assert.equal(captured["admin-results-table"].participants.at(-1).overall_place, 103, "Filtering must not rerank the event");
  t.diagnostic(`5000 participants: ${Math.round(Buffer.byteLength(large.roster) / 1024)} KiB of roster HTML, 50 editors; imports and summaries retain all 5000.`);
});
