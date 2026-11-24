"use server";

import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { publicResultsCacheTag } from "@/lib/public-results";
import { localDateTimeToUtc, slugify } from "@/lib/format";
import {
  buildColumns,
  detectHeaderRow,
  mergeUnmappedRosterFields,
  normalizeRosterRows,
  parseRosterCsv,
  parseRosterWorkbook,
  ROSTER_FIELDS,
  type RosterField,
  type RosterGridRow,
  type RosterImportRow,
  type RosterMapping,
} from "@/lib/roster-import";
import { normalizeDistance, normalizeParticipantSex } from "@/lib/participant-category";
import { prepareManualFinishes } from "@/lib/manual-finishes";
import { ageGroupValue } from "@/lib/classification";

async function signedInClient() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");
  return supabase;
}

function eventPath(eventId: string) {
  return "/admin/events/" + eventId;
}

async function invalidatePublicResults(supabase: Awaited<ReturnType<typeof createClient>>, eventId: string) {
  const { data: event } = await supabase.from("events").select("slug").eq("id", eventId).maybeSingle();
  if (event?.slug) updateTag(publicResultsCacheTag(event.slug));
}

function parseElapsedMilliseconds(value: string) {
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
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

function notice(path: string, kind: "ok" | "error", message: string): never {
  redirect(path + "?" + kind + "=" + encodeURIComponent(message));
}

export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function createEventAction(formData: FormData) {
  const supabase = await signedInClient();
  const name = String(formData.get("name") ?? "").trim();
  const organizer = String(formData.get("organizer") ?? "").trim() || null;
  const timezone = String(formData.get("timezone") ?? "America/Santiago").trim();
  const startAt = String(formData.get("start_at") ?? "").trim();
  const eventDate = String(formData.get("event_date") ?? "").trim();
  const distances = [...new Set(formData.getAll("distance").map((value) => normalizeDistance(String(value))).filter((value): value is string => Boolean(value)))];
  const { data: { user } } = await supabase.auth.getUser();
  if (name.length < 2 || name.length > 120) notice("/admin", "error", "El nombre debe tener entre 2 y 120 caracteres.");
  if (distances.length === 0 || distances.length > 20) notice("/admin", "error", "Define entre 1 y 20 distancias antes de crear el evento.");
  const distancePolicies = distances.map((distance) => {
    const policy = String(formData.get("distance_policy_" + distance) ?? "");
    return { distance, exclude_general_top3_from_categories: policy === "true", configured: policy === "true" || policy === "false" };
  });
  if (distancePolicies.some((policy) => !policy.configured)) notice("/admin", "error", "Selecciona una política de subpodio para cada distancia antes de crear el evento.");
  if (!user) redirect("/login");

  const baseSlug = slugify(name) || "evento";
  const suffix = crypto.randomUUID().slice(0, 6);
  const { data, error } = await supabase
    .from("events")
    .insert({
      owner_id: user.id,
      name,
      slug: baseSlug + "-" + suffix,
      organizer,
      timezone,
      event_date: /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : null,
      start_at: startAt ? new Date(startAt).toISOString() : null,
    })
    .select("id")
    .single();
  if (error || !data) notice("/admin", "error", error?.message ?? "No se pudo crear el evento.");
  const { error: distanceError } = await supabase.from("event_distances").insert(distancePolicies.map((policy) => ({
    event_id: data.id,
    distance: policy.distance,
    exclude_general_top3_from_categories: policy.exclude_general_top3_from_categories,
    award_policy_configured: true,
  })));
  if (distanceError) {
    await supabase.from("events").delete().eq("id", data.id);
    notice("/admin", "error", "No se guardaron las distancias y políticas del evento. Aplica la migración de políticas por distancia y vuelve a intentar.");
  }
  revalidatePath("/admin");
  redirect(eventPath(data.id));
}

export async function updateEventDateAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const eventDate = String(formData.get("event_date") ?? "").trim();
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(eventDate)) {
    notice(eventPath(eventId), "error", "Ingresa una fecha válida para el evento.");
  }
  const { error } = await supabase.from("events").update({ event_date: eventDate }).eq("id", eventId);
  if (error) notice(eventPath(eventId), "error", error.message);
  revalidatePath(eventPath(eventId));
  revalidatePath("/admin");
  notice(eventPath(eventId), "ok", "Fecha del evento actualizada.");
}

export async function updateEventStatusAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!["draft", "open", "closed", "published", "cancelled"].includes(status)) {
    notice(eventPath(eventId), "error", "Estado inválido.");
  }
  const { error } = await supabase.from("events").update({ status }).eq("id", eventId);
  if (error) notice(eventPath(eventId), "error", error.message);
  await invalidatePublicResults(supabase, eventId);
  revalidatePath(eventPath(eventId));
  revalidatePath("/admin");
  notice(eventPath(eventId), "ok", "Estado del evento actualizado.");
}

export async function updateDistanceAwardPolicyAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const distance = normalizeDistance(String(formData.get("distance") ?? ""));
  const policy = String(formData.get("exclude_general_top3_from_categories") ?? "");
  if (!distance || (policy !== "true" && policy !== "false")) {
    notice(eventPath(eventId), "error", "Selecciona una distancia y una política explícita.");
  }
  const { error } = await supabase.from("event_distances").update({
    exclude_general_top3_from_categories: policy === "true",
    award_policy_configured: true,
  }).eq("event_id", eventId).eq("distance", distance);
  if (error) notice(eventPath(eventId), "error", error.message);
  await invalidatePublicResults(supabase, eventId);
  revalidatePath(eventPath(eventId));
  notice(eventPath(eventId), "ok", "Política de subpodio actualizada para " + distance + ".");
}

export async function releaseLocalOperationAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const confirmUnpublished = formData.get("confirm_unpublished") === "on";
  if (reason.length < 5) notice(eventPath(eventId), "error", "Indica por qué se libera la autoridad local (al menos cinco caracteres).");
  const { error } = await supabase.rpc("release_local_operation", {
    p_event_id: eventId,
    p_reason: reason,
    p_confirm_unpublished: confirmUnpublished,
  });
  if (error) notice(eventPath(eventId), "error", error.message);
  revalidatePath(eventPath(eventId));
  revalidatePath("/admin");
  notice(eventPath(eventId), "ok", "La reserva de autoridad local quedó liberada con motivo auditado.");
}

export async function markUnfinishedParticipantsAsDnfAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  if (formData.get("confirm_dnf") !== "on") {
    notice(eventPath(eventId), "error", "Confirma que quieres marcar como DNF a quienes no tienen llegada.");
  }

  const { data: event } = await supabase.from("events").select("slug").eq("id", eventId).maybeSingle();
  if (!event) notice(eventPath(eventId), "error", "No se encontró el evento.");

  const { data, error } = await supabase.rpc("mark_unfinished_participants_as_dnf", { p_event_id: eventId });
  if (error) notice(eventPath(eventId), "error", error.message);
  await invalidatePublicResults(supabase, eventId);
  revalidatePath(eventPath(eventId));
  revalidatePath("/e/" + event.slug);
  notice(eventPath(eventId), "ok", data
    ? data + " participantes sin llegada marcados como DNF."
    : "No había participantes pendientes de llegada para marcar como DNF.");
}

export async function updatePublicFieldsAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const { error } = await supabase.from("events").update({
    qr_show_name: formData.get("qr_show_name") === "on",
    qr_show_bib: formData.get("qr_show_bib") === "on",
    qr_show_category: formData.get("qr_show_category") === "on",
  }).eq("id", eventId);
  if (error) notice(eventPath(eventId), "error", error.message);
  await invalidatePublicResults(supabase, eventId);
  revalidatePath(eventPath(eventId));
  notice(eventPath(eventId), "ok", "Preferencias de privacidad guardadas.");
}

export async function addParticipantAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const { data: policies } = await supabase.from("event_distances").select("distance,award_policy_configured").eq("event_id", eventId);
  if (!policies?.length || policies.some((item) => !item.award_policy_configured)) {
    notice(eventPath(eventId), "error", "Configura explícitamente la política por distancia antes de cargar corredores.");
  }
  const sex = normalizeParticipantSex(String(formData.get("sex") ?? ""));
  const distance = normalizeDistance(String(formData.get("distance") ?? ""));
  if (distance && !policies!.some((item) => normalizeDistance(item.distance) === distance)) {
    notice(eventPath(eventId), "error", "La distancia del corredor no está configurada para este evento.");
  }
  const rawAge = String(formData.get("age") ?? "").trim();
  const age = rawAge ? Number(rawAge) : null;
  if (rawAge && (!/^\d{1,3}$/.test(rawAge) || age! > 120)) notice(eventPath(eventId), "error", "La edad debe ser un entero entre 0 y 120.");
  const rawBracket = String(formData.get("age_bracket") ?? "").trim();
  const bracket = ageGroupValue(rawBracket);
  if (rawBracket && !bracket) notice(eventPath(eventId), "error", "Grupo etario inválido. Revisa el rango de edad.");
  const category = null; // Display category is calculated by event_results, never supplied by the form.
  const person = {
    participant_id: null,
    bib: String(formData.get("bib") ?? "").trim() || null,
    chip: String(formData.get("chip") ?? "").replace(/\s/g, "").toUpperCase() || null,
    first_name: String(formData.get("first_name") ?? "").trim(),
    last_name: String(formData.get("last_name") ?? "").trim() || null,
    sex,
    rut: String(formData.get("rut") ?? "").trim() || null,
    distance,
    age,
    age_bracket: bracket,
    category,
    team: String(formData.get("team") ?? "").trim() || null,
  };
  if (!person.first_name) notice(eventPath(eventId), "error", "El nombre del corredor es obligatorio.");
  const sourceValues = [person.bib, person.chip, person.first_name, person.last_name, person.sex, person.rut, person.distance, person.age, person.age_bracket, person.team].map((value) => value == null ? "" : String(value));
  const { error } = await supabase.rpc("import_event_roster", {
    p_event_id: eventId,
    p_rows: [{
      source_row: 1,
      source_sheet: null,
      source_values: sourceValues,
      mapped_fields: ["bib", "chip", "first_name", "last_name", "sex", "rut", "distance", "age", "age_bracket", "category", "team"],
      expected_values: {},
      participant: person,
      operation: "add",
      issues: [],
    }],
    p_source_name: "Alta manual",
    p_source_kind: "manual",
    p_source_sha256: createHash("sha256").update(JSON.stringify(person)).digest("hex"),
    p_mapping: {},
  });
  if (error) notice(eventPath(eventId), "error", error.message.includes("duplicate key")
    ? "Ese dorsal o chip ya está asignado en este evento."
    : error.message);
  await invalidatePublicResults(supabase, eventId);
  revalidatePath(eventPath(eventId));
  notice(eventPath(eventId), "ok", "Corredor añadido a la nómina.");
}

export async function changeParticipantAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const participantId = String(formData.get("participant_id") ?? "");
  const action = String(formData.get("operation") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!z.uuid().safeParse(eventId).success || !z.uuid().safeParse(participantId).success) notice("/admin", "error", "Evento o corredor inválido.");
  if (!["update", "remove", "dnf", "clear_dnf"].includes(action) || reason.length < 3 || reason.length > 200) notice(eventPath(eventId), "error", "Indica una acción válida y un motivo de entre 3 y 200 caracteres.");
  if (action === "remove" && formData.get("confirm_remove") !== "on") notice(eventPath(eventId), "error", "Confirma la baja del corredor.");
  let expected: unknown;
  try { expected = JSON.parse(String(formData.get("expected") ?? "")); }
  catch { notice(eventPath(eventId), "error", "Actualiza la nómina antes de editar al corredor."); }
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) notice(eventPath(eventId), "error", "Versión de nómina inválida.");
  let values = {};
  if (action === "dnf") {
    const expectedFinishAt = String(formData.get("expected_finish_at") ?? "").trim();
    if (expectedFinishAt && !Number.isFinite(Date.parse(expectedFinishAt))) notice(eventPath(eventId), "error", "No se pudo validar la llegada revisada. Actualiza la nómina.");
    if (expectedFinishAt && formData.get("confirm_finished_dnf") !== "on") notice(eventPath(eventId), "error", "Confirma expresamente que deseas marcar DNF a un corredor con llegada registrada.");
    values = { confirm_finished_dnf: formData.get("confirm_finished_dnf") === "on", expected_finish_at: expectedFinishAt || null };
  }
  if (action === "update") {
    const sex = normalizeParticipantSex(String(formData.get("sex") ?? ""));
    const distance = normalizeDistance(String(formData.get("distance") ?? ""));
    const rawAge = String(formData.get("age") ?? "").trim();
    if (rawAge && (!/^\d{1,3}$/.test(rawAge) || Number(rawAge) > 120)) notice(eventPath(eventId), "error", "La edad debe ser un entero entre 0 y 120.");
    const firstName = String(formData.get("first_name") ?? "").trim();
    if (!firstName || firstName.length > 100 || !distance) notice(eventPath(eventId), "error", "Indica nombre (hasta 100 caracteres) y distancia.");
    const rawBracket = String(formData.get("age_bracket") ?? "").trim();
  const bracket = ageGroupValue(rawBracket);
  if (rawBracket && !bracket) notice(eventPath(eventId), "error", "Grupo etario inválido. Revisa el rango de edad.");
    const category = null; // Display category is calculated by event_results, never supplied by the form.
    values = {
      bib: String(formData.get("bib") ?? "").trim() || null,
      chip: String(formData.get("chip") ?? "").replace(/\s/g, "").toUpperCase() || null,
      first_name: firstName, last_name: String(formData.get("last_name") ?? "").trim() || null,
      sex, distance, age: rawAge ? Number(rawAge) : null, age_bracket: bracket,
      category,
      rut: String(formData.get("rut") ?? "").trim() || null, team: String(formData.get("team") ?? "").trim() || null,
    };
  }
  const { error } = await supabase.rpc("change_event_participant", {
    p_event_id: eventId, p_participant_id: participantId, p_action: action, p_values: values, p_expected: expected, p_reason: reason,
  });
  if (error) notice(eventPath(eventId), "error", error.code === "23505" ? "Ese dorsal o chip ya está asignado en este evento." : error.message);
  await invalidatePublicResults(supabase, eventId);
  revalidatePath(eventPath(eventId));
  notice(eventPath(eventId), "ok", action === "update" ? "Datos del corredor actualizados con historial." : action === "remove" ? "Corredor dado de baja; sus datos y marcas se conservaron en el historial." : action === "dnf" ? "Corredor marcado como DNF." : "DNF retirado del corredor.");
}

export async function recordManualFinishesBatchAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  if (!z.uuid().safeParse(eventId).success) notice("/admin", "error", "Evento inválido.");
  const schema = z.array(z.object({
    input: z.object({ bib: z.string().max(100), mode: z.enum(["elapsed", "clock"]), value: z.string().max(100), reason: z.string().max(200) }),
    expected_start_at: z.string(), expected_finish_at: z.string().nullable(), participant_id: z.uuid(),
  })).min(1).max(5000);
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("rows") ?? "")); }
  catch { notice(eventPath(eventId), "error", "No se pudo leer la planilla. Revísala nuevamente."); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) notice(eventPath(eventId), "error", "La planilla contiene filas inválidas o supera 5000 llegadas.");
  const { data: event } = await supabase.from("events").select("timezone").eq("id", eventId).maybeSingle();
  if (!event) notice("/admin", "error", "No se encontró el evento.");
  const participants = [];
  const ids = parsed.data.map((row) => row.participant_id);
  // Small ID batches avoid PostgREST URL and row limits on large events.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { data, error } = await supabase.from("event_results")
      .select("participant_id,bib,first_name,last_name,start_at,finish_at,result_status")
      .eq("event_id", eventId).in("participant_id", ids.slice(offset, offset + 100));
    if (error) notice(eventPath(eventId), "error", "No se pudieron validar las marcas de la nómina.");
    participants.push(...(data ?? []));
  }
  let prepared;
  try {
    prepared = prepareManualFinishes(parsed.data.map((row) => row.input), participants.map((p) => ({
      id: p.participant_id, bib: p.bib, name: [p.first_name, p.last_name].filter(Boolean).join(" "),
      startAt: p.start_at, finishAt: p.finish_at, dnf: p.result_status === "DNF",
    })), event.timezone, String(formData.get("reason") ?? ""));
  } catch (cause) { notice(eventPath(eventId), "error", cause instanceof Error ? cause.message : "Planilla inválida."); }
  const payload = prepared.map((row, index) => {
    if (row.error || !row.prepared) notice(eventPath(eventId), "error", `Fila ${index + 1}: ${row.error}`);
    const reviewed = parsed.data[index];
    if (reviewed.participant_id !== row.prepared.participant_id || reviewed.expected_start_at !== row.prepared.expected_start_at || reviewed.expected_finish_at !== row.prepared.expected_finish_at) {
      notice(eventPath(eventId), "error", `Las marcas de la fila ${index + 1} cambiaron. Revisa nuevamente la planilla.`);
    }
    return row.prepared;
  });
  const { data, error } = await supabase.rpc("record_manual_finishes_batch", { p_event_id: eventId, p_rows: payload });
  if (error) notice(eventPath(eventId), "error", error.message);
  await invalidatePublicResults(supabase, eventId);
  revalidatePath(eventPath(eventId));
  redirect(eventPath(eventId) + "?ok=" + encodeURIComponent(`Se guardaron ${data} llegadas en una sola operación y con historial por fila.`) + "&batch_saved=" + randomUUID());
}

const rosterOperationSchema = z.array(z.object({
  source_row: z.number().int().positive(),
  operation: z.enum(["add", "update", "unchanged", "skip"]),
  participant_id: z.string().uuid().nullable(),
  expected_values: z.record(z.string(), z.unknown()).default({}),
  corrections: z.record(z.string(), z.string().max(1000)).default({}),
  skip_confirmed: z.boolean().default(false),
}).strict()).min(1).max(6000);

function applyRosterCorrections(
  rows: RosterGridRow[],
  mapping: RosterMapping,
  operations: z.infer<typeof rosterOperationSchema>,
  sourceRowOffset = 0,
) {
  const bySourceRow = new Map(operations.map((operation) => [operation.source_row, operation]));
  return rows.map((row) => {
    const operation = bySourceRow.get(row.sourceRow + sourceRowOffset);
    if (!operation || !Object.keys(operation.corrections).length) return row;
    const cells = [...row.cells];
    for (const [rawField, value] of Object.entries(operation.corrections)) {
      if (!(ROSTER_FIELDS as readonly string[]).includes(rawField)) throw new Error("La vista previa contiene un campo de corrección no válido.");
      const field = rawField as RosterField;
      const columnIndex = mapping[field];
      if (columnIndex == null) throw new Error("La corrección hace referencia a un campo que ya no está mapeado. Vuelve a previsualizar.");
      cells[columnIndex] = {
        ...(cells[columnIndex] ?? { value: "" }),
        value,
        formulaWithoutResult: false,
        unsafeNumber: false,
      };
    }
    return { ...row, cells };
  });
}

function parseRosterMapping(value: string): RosterMapping {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("No se pudo leer el mapeo de columnas. Vuelve a previsualizar el archivo.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("El mapeo de columnas es inválido.");
  const entries = Object.entries(parsed as Record<string, unknown>);
  const mapping: RosterMapping = {};
  for (const [field, index] of entries) {
    if (!(ROSTER_FIELDS as readonly string[]).includes(field)) throw new Error("El mapeo contiene un campo desconocido.");
    if (index !== null && (!Number.isInteger(index) || Number(index) < 0 || Number(index) > 99)) throw new Error("El mapeo contiene una columna inválida.");
    mapping[field as RosterField] = index as number | null;
  }
  const selected = Object.values(mapping).filter((index) => index != null);
  if (new Set(selected).size !== selected.length) throw new Error("Una columna no puede asignarse a más de un campo.");
  return mapping;
}

export async function importRosterAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const { data: distancePolicies, error: distancePolicyError } = await supabase.from("event_distances")
    .select("distance,award_policy_configured").eq("event_id", eventId);
  if (distancePolicyError || !distancePolicies?.length || distancePolicies.some((item) => !item.award_policy_configured)) {
    notice(eventPath(eventId), "error", "Configura explícitamente la política del podio por cada distancia antes de cargar la nómina.");
  }
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) notice(eventPath(eventId), "error", "Selecciona un archivo CSV o XLSX.");

  const fileName = file.name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || "nomina";
  const kind = fileName.toLowerCase().endsWith(".csv") ? "csv" : fileName.toLowerCase().endsWith(".xlsx") ? "xlsx" : null;
  if (!kind) notice(eventPath(eventId), "error", "Formato no admitido. Selecciona CSV o XLSX sin macros.");
  if ((kind === "csv" && file.size > 5 * 1024 * 1024) || (kind === "xlsx" && file.size > 10 * 1024 * 1024)) {
    notice(eventPath(eventId), "error", kind === "csv" ? "El CSV supera el límite de 5 MB." : "El XLSX supera el límite de 10 MB comprimidos.");
  }

  let mapping: RosterMapping;
  let operations: z.infer<typeof rosterOperationSchema>;
  try {
    mapping = parseRosterMapping(String(formData.get("mapping") ?? ""));
    operations = rosterOperationSchema.parse(JSON.parse(String(formData.get("operations") ?? "")));
  } catch (cause) {
    notice(eventPath(eventId), "error", cause instanceof Error ? cause.message : "La confirmación de la vista previa es inválida.");
  }
  const distance = String(formData.get("default_distance") ?? "").trim();
  if (distance.length > 32) notice(eventPath(eventId), "error", "La distancia supera 32 caracteres.");
  const sourceSheet = String(formData.get("source_sheet") ?? "");
  const headerSourceRow = Number(formData.get("header_source_row"));
  if (!Number.isInteger(headerSourceRow) || headerSourceRow < 1) notice(eventPath(eventId), "error", "Selecciona una fila de encabezados antes de confirmar.");

  const bytes = await file.arrayBuffer();
  const sourceHash = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  let rows: RosterImportRow[];
  try {
    if (kind === "csv") {
      const encodingValue = String(formData.get("encoding") ?? "utf-8");
      const encoding = encodingValue === "windows-1252" ? "windows-1252" : "utf-8";
      const separatorValue = String(formData.get("delimiter") ?? ",");
      const delimiter = [",", ";", "\t"].includes(separatorValue) ? separatorValue : ",";
      const decoded = new TextDecoder(encoding).decode(bytes);
      const allRows = parseRosterCsv(decoded, delimiter);
      const headerIndex = allRows.findIndex((row) => row.sourceRow === headerSourceRow);
      if (headerIndex < 0) throw new Error("La fila de encabezados ya no coincide con el archivo enviado.");
      const sourceRows = allRows.slice(headerIndex + 1);
      const columns = buildColumns(allRows[headerIndex], sourceRows);
      rows = normalizeRosterRows(applyRosterCorrections(sourceRows, mapping, operations), columns, mapping, distance, null);
    } else {
      const workbook = parseRosterWorkbook(bytes);
      if (sourceSheet === "__all__") {
        let referenceHeaders: string | null = null;
        rows = workbook.flatMap((sheet, sheetIndex) => {
          const detectedHeader = detectHeaderRow(sheet.rows);
          if (detectedHeader < 0) throw new Error(`La hoja “${sheet.name}” no tiene encabezados reconocibles.`);
          const header = sheet.rows[detectedHeader];
          const sourceRows = sheet.rows.filter((row) => row.sourceRow > header.sourceRow);
          const columns = buildColumns(header, sourceRows);
          const signature = JSON.stringify(columns.map((column) => column.name.trim().normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-CL")));
          if (referenceHeaders !== null && signature !== referenceHeaders) {
            throw new Error(`La hoja “${sheet.name}” no tiene los mismos encabezados y orden que la primera hoja.`);
          }
          referenceHeaders = signature;
          return normalizeRosterRows(applyRosterCorrections(sourceRows, mapping, operations, sheetIndex * 10000), columns,
            mapping, sheet.name, sheet.name).map((row) => ({ ...row, source_row: row.source_row + sheetIndex * 10000 }));
        });
      } else {
      const selectedSheet = workbook.find((sheet) => sheet.name === sourceSheet);
      if (!selectedSheet) throw new Error("La hoja seleccionada ya no existe en el libro.");
      const headerIndex = selectedSheet.rows.findIndex((row) => row.sourceRow === headerSourceRow);
      if (headerIndex < 0) throw new Error("La fila de encabezados ya no coincide con la hoja enviada.");
      const sourceRows = selectedSheet.rows.slice(headerIndex + 1);
      const columns = buildColumns(selectedSheet.rows[headerIndex], sourceRows);
      rows = normalizeRosterRows(applyRosterCorrections(sourceRows, mapping, operations), columns, mapping, distance, sourceSheet);
      }
    }
  } catch (cause) {
    notice(eventPath(eventId), "error", cause instanceof Error ? cause.message : "No se pudo validar el archivo enviado.");
  }
  if (rows.length > 6000) notice(eventPath(eventId), "error", "La importación admite hasta 6000 filas con datos.");
  const { data: configuredDistances, error: configuredDistanceError } = await supabase.from("event_distances")
    .select("distance,award_policy_configured").eq("event_id", eventId);
  const configuredDistanceKeys = new Set((configuredDistances ?? []).map((item) => normalizeDistance(item.distance)));
  if (configuredDistanceError || !configuredDistances?.length || configuredDistances.some((item) => !item.award_policy_configured)) {
    notice(eventPath(eventId), "error", "Configura explícitamente la política por distancia antes de cargar corredores.");
  }
  if (rows.some((row) => row.operation !== "skip" && row.participant.distance && !configuredDistanceKeys.has(row.participant.distance))) {
    notice(eventPath(eventId), "error", "La nómina contiene una distancia que no fue definida en la configuración del evento.");
  }
  if (rows.length !== operations.length || rows.some((row, index) => row.source_row !== operations[index].source_row)) {
    notice(eventPath(eventId), "error", "El archivo cambió después de la vista previa. Vuelve a leerlo y revisa las diferencias.");
  }

  const participantIds = [...new Set(operations
    .filter((row) => (row.operation === "update" || row.operation === "unchanged") && row.participant_id)
    .map((row) => row.participant_id!))];
  const existingById = new Map<string, Record<string, unknown>>();
  if (participantIds.length) {
    const { data: currentParticipants, error: rosterError } = await supabase.from("event_participants")
      .select("id,bib,chip,first_name,last_name,sex,rut,distance,age,age_bracket,category,team")
      .eq("event_id", eventId)
      .in("id", participantIds);
    if (rosterError) notice(eventPath(eventId), "error", rosterError.message);
    for (const current of currentParticipants ?? []) existingById.set(current.id, current as Record<string, unknown>);
  }

  const seenBibs = new Map<string, number>();
  const seenChips = new Map<string, number>();
  const reviewedRows: RosterImportRow[] = rows.map((row, index) => {
    const selection = operations[index];
    const participantId = selection.participant_id;
    if ((selection.operation === "update" || selection.operation === "unchanged") && !participantId) {
      notice(eventPath(eventId), "error", "Una fila de actualización perdió el ID estable. Vuelve a revisar la vista previa.");
    }
    if (selection.operation === "add" && row.participant.participant_id) {
      notice(eventPath(eventId), "error", "Una fila con ID estable no puede importarse como alta nueva.");
    }
    if ((selection.operation === "add" || selection.operation === "update") && row.issues.some((issue) => issue.level === "error")) {
      notice(eventPath(eventId), "error", `La fila ${row.source_row} conserva errores bloqueantes. Resuélvelos o sáltala.`);
    }
    if (selection.operation === "skip" && row.issues.some((issue) => issue.level === "error") && !selection.skip_confirmed) {
      notice(eventPath(eventId), "error", `La fila ${row.source_row} conserva errores. Corrígela o confirma expresamente que quieres omitirla.`);
    }
    let nextRow = row;
    if (selection.operation === "update" || selection.operation === "unchanged") {
      const existing = participantId ? existingById.get(participantId) : null;
      if (!existing) notice(eventPath(eventId), "error", `El participante de la fila ${row.source_row} cambió o ya no pertenece al evento. Vuelve a previsualizar.`);
      const expected = selection.expected_values;
      const allowedFields = new Set(["bib", "chip", "first_name", "last_name", "sex", "rut", "distance", "age", "age_bracket", "category", "team"]);
      if (Object.keys(expected).some((field) => !allowedFields.has(field))) notice(eventPath(eventId), "error", "La vista previa contiene campos de comparación no válidos.");
      for (const [field, value] of Object.entries(expected)) {
        if (existing[field] !== value) notice(eventPath(eventId), "error", `El participante de la fila ${row.source_row} cambió después de la vista previa. Vuelve a revisar la nómina.`);
      }
      const merged = mergeUnmappedRosterFields(row.participant, existing as unknown as RosterImportRow["participant"], row.mapped_fields);
      nextRow = { ...row, participant: { ...merged.participant, participant_id: participantId }, mapped_fields: merged.mappedFields };
      if (selection.operation === "unchanged" && nextRow.mapped_fields.some((field) => nextRow.participant[field] !== existing[field])) {
        notice(eventPath(eventId), "error", `La fila ${row.source_row} ahora contiene cambios. Vuelve a previsualizar antes de aplicar.`);
      }
    }
    const nextParticipant = { ...nextRow.participant, participant_id: selection.operation === "add" ? null : participantId };
    if (selection.operation === "add" || selection.operation === "update") {
      const distanceKey = normalizeDistance(nextParticipant.distance ?? "");
      if (!distanceKey) notice(eventPath(eventId), "error", `La fila ${row.source_row} no tiene distancia. Asigna una distancia del evento antes de confirmar.`);
      if (!configuredDistanceKeys.has(distanceKey)) notice(eventPath(eventId), "error", `La distancia ${distanceKey} de la fila ${row.source_row} no está configurada para este evento.`);
      if (nextParticipant.bib && seenBibs.has(nextParticipant.bib)) notice(eventPath(eventId), "error", `Dorsal duplicado dentro de la vista previa: ${nextParticipant.bib}, filas ${seenBibs.get(nextParticipant.bib)} y ${row.source_row}.`);
      if (nextParticipant.chip && seenChips.has(nextParticipant.chip)) notice(eventPath(eventId), "error", `Chip duplicado dentro de la vista previa: ${nextParticipant.chip}, filas ${seenChips.get(nextParticipant.chip)} y ${row.source_row}.`);
      if (nextParticipant.bib) seenBibs.set(nextParticipant.bib, row.source_row);
      if (nextParticipant.chip) seenChips.set(nextParticipant.chip, row.source_row);
    }
    return { ...nextRow, participant: nextParticipant, expected_values: selection.expected_values, operation: selection.operation };
  });
  if (!reviewedRows.some((row) => row.operation !== "skip")) {
    notice(eventPath(eventId), "error", "Confirma al menos una fila válida para guardar una versión de nómina.");
  }
  if (Buffer.byteLength(JSON.stringify(reviewedRows), "utf8") > 8 * 1024 * 1024) {
    notice(eventPath(eventId), "error", "La vista previa expandida supera 8 MB. Divide la nómina en archivos más pequeños antes de importarla.");
  }

  const [{ data: event }, { data, error: importError }] = await Promise.all([
    supabase.from("events").select("slug").eq("id", eventId).maybeSingle(),
    supabase.rpc("import_event_roster", {
      p_event_id: eventId,
      p_rows: reviewedRows,
      p_source_name: fileName,
      p_source_kind: kind,
      p_source_sha256: sourceHash,
      p_mapping: mapping,
    }),
  ]);
  if (importError) {
    const message = importError.message.toLowerCase();
    notice(eventPath(eventId), "error", message.includes("duplicate key")
      ? "Dorsal o chip ya asignado en el evento. Actualiza la fila coincidente o sáltala; no se aplicó ningún cambio."
      : message.includes("already started")
        ? "La distancia ya comenzó. No se cambió la distancia de ningún participante."
        : message.includes("changed after preview")
          ? "La nómina cambió después de la vista previa. Vuelve a cargar el archivo y revisa las diferencias."
        : importError.message);
  }
  if (!event) notice(eventPath(eventId), "error", "No se encontró el evento.");
  updateTag(publicResultsCacheTag(event.slug));
  revalidatePath(eventPath(eventId));
  revalidatePath("/e/" + event.slug);
  const summary = data as { revision: number; added: number; updated: number; unchanged: number; skipped: number; issues: number };
  notice(eventPath(eventId), "ok", `Nómina v${summary.revision}: ${summary.added} altas, ${summary.updated} cambios, ${summary.unchanged} sin cambios y ${summary.skipped} omitidas.`);
}

export async function recordManualEntryAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const participantId = String(formData.get("participant_id") ?? "");
  const stage = String(formData.get("stage") ?? "");
  const dateTime = String(formData.get("captured_at") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (stage !== "start") notice(eventPath(eventId), "error", "Las llegadas manuales se ingresan como tiempo transcurrido desde la salida.");
  if (!participantId) notice(eventPath(eventId), "error", "Busca y selecciona un corredor en los resultados.");
  if (reason.length < 3) notice(eventPath(eventId), "error", "Registra un motivo de al menos 3 caracteres.");
  const { data: event } = await supabase.from("events").select("timezone,slug").eq("id", eventId).single();
  if (!event) notice(eventPath(eventId), "error", "No se encontró el evento.");

  let capturedAt: string;
  try {
    capturedAt = localDateTimeToUtc(dateTime, event.timezone);
  } catch (error) {
    notice(eventPath(eventId), "error", error instanceof Error ? error.message : "Fecha y hora inválidas.");
  }
  const { error } = await supabase.rpc("record_manual_entry", {
    p_event_id: eventId,
    p_participant_id: participantId,
    p_stage: stage,
    p_captured_at: capturedAt!,
    p_reason: reason,
  });
  if (error) notice(eventPath(eventId), "error", error.message);
  updateTag(publicResultsCacheTag(event.slug));
  revalidatePath(eventPath(eventId));
  revalidatePath("/e/" + event.slug);
  notice(eventPath(eventId), "ok", "Salida manual guardada en el historial.");
}

export async function recordManualFinishByElapsedAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const participantId = String(formData.get("participant_id") ?? "");
  const elapsedInput = String(formData.get("elapsed_time") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!participantId) notice(eventPath(eventId), "error", "Busca y selecciona un corredor en los resultados.");
  if (reason.length < 3) notice(eventPath(eventId), "error", "Registra un motivo de al menos 3 caracteres.");
  const elapsedMilliseconds = parseElapsedMilliseconds(elapsedInput);
  if (elapsedMilliseconds === null) {
    notice(eventPath(eventId), "error", "Ingresa el tiempo como HH:MM:SS o MM:SS; puedes agregar centésimas o milésimas.");
  }

  const [{ data: event }, { data: participant }] = await Promise.all([
    supabase.from("events").select("slug").eq("id", eventId).single(),
    supabase.from("event_results").select("start_at").eq("event_id", eventId).eq("participant_id", participantId).maybeSingle(),
  ]);
  if (!event) notice(eventPath(eventId), "error", "No se encontró el evento.");
  if (!participant) notice(eventPath(eventId), "error", "El corredor no pertenece a este evento.");
  if (!participant.start_at) notice(eventPath(eventId), "error", "El corredor no tiene salida registrada; registra primero la salida de su distancia.");

  const startMilliseconds = Date.parse(participant.start_at);
  if (!Number.isFinite(startMilliseconds)) notice(eventPath(eventId), "error", "No se pudo leer la hora de salida del corredor.");
  const finishMilliseconds = startMilliseconds + elapsedMilliseconds!;
  if (!Number.isFinite(finishMilliseconds) || Math.abs(finishMilliseconds) > 8_640_000_000_000_000) {
    notice(eventPath(eventId), "error", "El tiempo transcurrido es demasiado grande.");
  }
  const capturedAt = new Date(finishMilliseconds).toISOString();
  const { error } = await supabase.rpc("record_manual_entry", {
    p_event_id: eventId,
    p_participant_id: participantId,
    p_stage: "finish",
    p_captured_at: capturedAt,
    p_reason: reason,
  });
  if (error) notice(eventPath(eventId), "error", error.message);
  updateTag(publicResultsCacheTag(event.slug));
  revalidatePath(eventPath(eventId));
  revalidatePath("/e/" + event.slug);
  notice(eventPath(eventId), "ok", "Llegada manual guardada a partir del tiempo transcurrido.");
}

export async function importFinishCorrectionsAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const rawCorrections = String(formData.get("corrections") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length < 3 || reason.length > 200) {
    notice(eventPath(eventId), "error", "Indica un motivo de entre 3 y 200 caracteres.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCorrections);
  } catch {
    notice(eventPath(eventId), "error", "No se pudo leer la lista de rectificaciones. Vuelve a revisar el CSV.");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 5000) {
    notice(eventPath(eventId), "error", "La carga admite entre 1 y 5000 rectificaciones.");
  }

  const seenBibs = new Set<string>();
  const corrections: { bib: string; elapsed_milliseconds: number; csv_row: number }[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") notice(eventPath(eventId), "error", "Una fila del archivo tiene datos inválidos.");
    const row = item as Record<string, unknown>;
    const bib = typeof row.bib === "string" ? row.bib.trim() : "";
    const elapsedMilliseconds = row.elapsed_milliseconds;
    const csvRow = row.csv_row;
    if (!bib || !Number.isSafeInteger(elapsedMilliseconds) || Number(elapsedMilliseconds) < 1 || Number(elapsedMilliseconds) > 31_536_000_000) {
      notice(eventPath(eventId), "error", "Una fila del archivo tiene dorsal o tiempo inválido.");
    }
    if (!Number.isSafeInteger(csvRow) || Number(csvRow) < 2) {
      notice(eventPath(eventId), "error", "Una fila del archivo tiene un número de fila inválido.");
    }
    if (seenBibs.has(bib)) notice(eventPath(eventId), "error", "El archivo repite el dorsal " + bib + ".");
    seenBibs.add(bib);
    corrections.push({ bib, elapsed_milliseconds: Number(elapsedMilliseconds), csv_row: Number(csvRow) });
  }

  const { data, error } = await supabase.rpc("import_finish_corrections", {
    p_event_id: eventId,
    p_corrections: corrections,
    p_reason: reason,
  });
  if (error) notice(eventPath(eventId), "error", error.message);
  const { data: event } = await supabase.from("events").select("slug").eq("id", eventId).maybeSingle();
  revalidatePath(eventPath(eventId));
  if (event) {
    updateTag(publicResultsCacheTag(event.slug));
    revalidatePath("/e/" + event.slug);
  }
  notice(eventPath(eventId), "ok", "Se aplicaron " + data + " rectificaciones de llegada y quedaron en el historial.");
}

export async function recordDistanceStartManuallyAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const distance = normalizeDistance(String(formData.get("distance") ?? ""));
  const dateTime = String(formData.get("captured_at") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const confirmReplace = formData.get("confirm_replace") === "on";
  if (!distance || reason.length < 3) {
    notice(eventPath(eventId), "error", "Indica la distancia y un motivo de al menos 3 caracteres.");
  }

  const { data: event } = await supabase.from("events").select("timezone,slug").eq("id", eventId).single();
  if (!event) notice(eventPath(eventId), "error", "No se encontró el evento.");

  let capturedAt: string;
  try {
    capturedAt = localDateTimeToUtc(dateTime, event.timezone);
  } catch (error) {
    notice(eventPath(eventId), "error", error instanceof Error ? error.message : "Hora real inválida.");
  }

  const { data, error } = await supabase.rpc("record_distance_start_manually", {
    p_event_id: eventId,
    p_distance: distance,
    p_captured_at: capturedAt!,
    p_reason: reason,
    p_confirm_replace: confirmReplace,
  });
  if (error) notice(eventPath(eventId), "error", error.message);
  updateTag(publicResultsCacheTag(event.slug));
  revalidatePath(eventPath(eventId));
  revalidatePath("/e/" + event.slug);
  notice(eventPath(eventId), "ok", "Hora real de " + distance + " guardada para " + data + " corredores.");
}

export async function saveDistanceScheduleAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const distance = normalizeDistance(String(formData.get("distance") ?? ""));
  const dateTime = String(formData.get("official_start_at") ?? "").trim();
  if (!distance) notice(eventPath(eventId), "error", "Indica una distancia válida.");

  const [{ data: event }, { data: group }] = await Promise.all([
    supabase.from("events").select("timezone").eq("id", eventId).single(),
    supabase.from("event_distances").select("started_at").eq("event_id", eventId).eq("distance", distance).single(),
  ]);
  if (!event || !group) notice(eventPath(eventId), "error", "No se encontró la distancia de esta carrera.");
  if (group.started_at) notice(eventPath(eventId), "error", "La distancia ya inició; su hora oficial quedó bloqueada.");

  let officialStartAt: string | null = null;
  if (dateTime) {
    try {
      officialStartAt = localDateTimeToUtc(dateTime, event.timezone);
    } catch (error) {
      notice(eventPath(eventId), "error", error instanceof Error ? error.message : "Hora oficial inválida.");
    }
  }

  const { error } = await supabase.from("event_distances")
    .update({ official_start_at: officialStartAt })
    .eq("event_id", eventId)
    .eq("distance", distance);
  if (error) notice(eventPath(eventId), "error", error.message);
  revalidatePath(eventPath(eventId));
  notice(eventPath(eventId), "ok", "Hora oficial guardada para " + distance + ".");
}

export async function startEventDistanceAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const distance = normalizeDistance(String(formData.get("distance") ?? ""));
  if (!distance) notice(eventPath(eventId), "error", "Indica una distancia válida.");
  const { data: event } = await supabase.from("events").select("slug").eq("id", eventId).single();
  if (!event) notice(eventPath(eventId), "error", "No se encontró el evento.");
  const { data, error } = await supabase.rpc("start_event_distance", {
    p_event_id: eventId,
    p_distance: distance,
  });
  if (error) notice(eventPath(eventId), "error", error.message);
  await invalidatePublicResults(supabase, eventId);
  revalidatePath(eventPath(eventId));
  revalidatePath("/e/" + event.slug);
  notice(eventPath(eventId), "ok", "Salida de " + distance + " asignada a " + data + " corredores.");
}

export async function voidTimingEntryAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const participantId = String(formData.get("participant_id") ?? "");
  const stage = String(formData.get("stage") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const { error } = await supabase.rpc("void_timing_entry", {
    p_event_id: eventId,
    p_participant_id: participantId,
    p_stage: stage,
    p_reason: reason,
  });
  if (error) notice(eventPath(eventId), "error", error.message);
  await invalidatePublicResults(supabase, eventId);
  revalidatePath(eventPath(eventId));
  notice(eventPath(eventId), "ok", "Marca anulada; el historial conserva el valor anterior.");
}

export async function reprocessIngestReceiptsAction(formData: FormData) {
  const supabase = await signedInClient();
  const eventId = String(formData.get("event_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const rawReceiptIds = formData.getAll("receipt_id").map((value) => Number(value));
  const recoveryFiles = formData.getAll("recovery_payloads").filter((value): value is File => value instanceof File && value.size > 0);
  const windowStartInput = String(formData.get("window_start") ?? "").trim();
  const windowEndInput = String(formData.get("window_end") ?? "").trim();
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!uuidPattern.test(eventId)) notice("/admin", "error", "Evento inválido.");
  if (reason.length < 5 || reason.length > 200) {
    notice(eventPath(eventId), "error", "Indica un motivo de entre 5 y 200 caracteres.");
  }
  if (rawReceiptIds.length < 1 || rawReceiptIds.length > 100 || rawReceiptIds.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(rawReceiptIds).size !== rawReceiptIds.length) {
    notice(eventPath(eventId), "error", "Selecciona entre 1 y 100 recibos válidos, sin repetir.");
  }
  if (recoveryFiles.length > 100 || recoveryFiles.some((file) => file.size > 32_768) ||
      recoveryFiles.reduce((total, file) => total + file.size, 0) > 512_000) {
    notice(eventPath(eventId), "error", "Los archivos de recuperación superan el máximo de 500 KB o 32 KB por lectura.");
  }
  const recoveryPayloads: unknown[] = [];
  try {
    for (const file of recoveryFiles) {
      const parsed: unknown = JSON.parse(await file.text());
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      if (!entries.length || entries.length > 100 || entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
        notice(eventPath(eventId), "error", "Un archivo de recuperación no contiene lecturas válidas.");
      }
      recoveryPayloads.push(...entries);
      if (recoveryPayloads.length > 100) notice(eventPath(eventId), "error", "La recuperación admite hasta 100 lecturas.");
    }
  } catch {
    notice(eventPath(eventId), "error", "No se pudo leer un archivo JSON de recuperación.");
  }

  const { data: event } = await supabase.from("events").select("timezone,status,slug").eq("id", eventId).maybeSingle();
  if (!event) notice("/admin", "error", "No se encontró el evento.");
  if (event.status !== "open") notice(eventPath(eventId), "error", "Abre la recepción RFID antes de reprocesar lecturas.");

  let windowStart: string;
  let windowEnd: string;
  try {
    windowStart = localDateTimeToUtc(windowStartInput, event.timezone);
    windowEnd = localDateTimeToUtc(windowEndInput, event.timezone);
  } catch (error) {
    notice(eventPath(eventId), "error", error instanceof Error ? error.message : "Ventana temporal inválida.");
  }
  if (Date.parse(windowStart!) >= Date.parse(windowEnd!)) {
    notice(eventPath(eventId), "error", "El final de la ventana debe ser posterior al inicio.");
  }

  const { data, error } = await supabase.rpc("reprocess_ingest_receipts", {
    p_event_id: eventId,
    p_receipt_ids: rawReceiptIds,
    p_reason: reason,
    p_window_start: windowStart!,
    p_window_end: windowEnd!,
    p_recovery_payloads: recoveryPayloads,
  });
  if (error) notice(eventPath(eventId), "error", error.message);
  const processed = data && typeof data === "object" && "processed" in data
    ? Number((data as { processed: unknown }).processed) : rawReceiptIds.length;
  await invalidatePublicResults(supabase, eventId);
  revalidatePath(eventPath(eventId));
  revalidatePath("/e/" + event.slug);
  notice(eventPath(eventId), "ok", "Se reprocesaron " + processed + " lecturas con su ID y hora originales; la auditoría conserva el rechazo previo.");
}

