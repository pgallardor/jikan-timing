// Category identity is a tuple of criteria, never a display label.
// New criteria require a versioned implementation in SQL and the offline engine.
export const CATEGORY_POLICY = "category_criteria_v1";
export const CATEGORY_CRITERIA = ["sex", "age_bracket"] as const;
export type ClassificationFields = { sex: string | null; age_bracket: string | null };

export function ageGroupValue(value: string | null): string | null {
  const text = (value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
  if (!text) return null;
  const match = text.match(/^(\d{1,3})\s*(?:a|al|hasta|[-–—])\s*(\d{1,3})(?:\s*(?:años?|anos?))?$/i);
  if (match) {
    const [lower, upper] = [Number(match[1]), Number(match[2])];
    if (lower > upper || upper > 120) return null;
    return `${lower} a ${upper} años`;
  }
  // Non-range groups (e.g. U18) are explicit criterion values, not category names.
  return /^\d+$/.test(text) ? null : text.toUpperCase();
}

export function categoryIdentity(person: ClassificationFields): string | null {
  const bracket = ageGroupValue(person.age_bracket);
  return ["F", "M", "otro"].includes(person.sex ?? "") && bracket
    ? JSON.stringify([person.sex, bracket]) : null;
}

export function categoryLabel(person: ClassificationFields): string | null {
  const bracket = ageGroupValue(person.age_bracket);
  if (!categoryIdentity(person)) return null;
  return `${person.sex === "F" ? "Damas" : person.sex === "M" ? "Varones" : "Otro"} · ${bracket}`;
}
