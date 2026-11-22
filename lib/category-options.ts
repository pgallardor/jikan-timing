import { normalizeAgeBracket, normalizeDistance } from "./participant-category";

export type CategorySource = { distance: string | null; category: string | null; age_bracket: string | null };
export type CategoryCatalog = Record<string, string[]>;
const clean = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ");
export const categoryKey = (value: string) => clean(value).toLocaleUpperCase("es-CL");
export const existingCategoryChoice = (value: string) => "existing:" + encodeURIComponent(value);

export function participantBaseCategory(category: string | null, ageBracket: string | null): string | null {
  let base = clean(category ?? "");
  for (const bracket of [ageBracket, normalizeAgeBracket(ageBracket ?? "")]) {
    const suffix = " · " + clean(bracket ?? "");
    if (bracket && categoryKey(base).endsWith(categoryKey(suffix))) {
      base = base.slice(0, -suffix.length).trim();
      break;
    }
  }
  return base || null;
}

export function buildCategoryCatalog(participants: CategorySource[]): CategoryCatalog {
  const catalog: CategoryCatalog = {};
  for (const person of participants) {
    const distance = normalizeDistance(person.distance ?? "");
    const category = participantBaseCategory(person.category, person.age_bracket);
    if (!distance || !category) continue;
    const options = catalog[distance] ?? (catalog[distance] = []);
    if (!options.some((option) => categoryKey(option) === categoryKey(category))) options.push(category);
  }
  for (const options of Object.values(catalog)) options.sort((a, b) => a.localeCompare(b, "es-CL", { numeric: true, sensitivity: "base" }));
  return catalog;
}

export function categoryAfterDistanceChange(previous: string | null, options: string[]): string | null {
  return previous ? options.find((option) => categoryKey(option) === categoryKey(previous)) ?? null : null;
}

export function resolveCategoryChoice(choice: string, newCategory: string, options: string[]): string | null {
  if (choice === "") return null;
  if (choice === "new") {
    const value = clean(newCategory);
    if (!value || value.length > 120) throw new Error("La nueva categoría debe tener entre 1 y 120 caracteres.");
    return options.find((option) => categoryKey(option) === categoryKey(value)) ?? value;
  }
  if (choice.startsWith("existing:")) {
    let selected: string;
    try { selected = decodeURIComponent(choice.slice("existing:".length)); }
    catch { throw new Error("La categoría seleccionada no es válida."); }
    const existing = options.find((option) => categoryKey(option) === categoryKey(selected));
    if (!existing) throw new Error("La categoría ya no está disponible en esta distancia. Actualiza la nómina o elige Crear otra categoría.");
    return existing;
  }
  throw new Error("Selecciona una categoría existente o elige Crear otra categoría.");
}
