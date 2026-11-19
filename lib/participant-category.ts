export type ParticipantSex = "F" | "M" | "otro" | "no_informado";

export function normalizeDistance(value: string): string | null {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  const match = cleaned.match(/(\d+(?:[.,]\d+)?)\s*(kms?|k|metros?|m)\b/i);
  if (!match) return cleaned.toLocaleUpperCase("es-CL");
  const amount = Number(match[1].replace(",", "."));
  const unit = match[2].toLocaleLowerCase("es-CL");
  return `${amount}${unit.startsWith("m") ? "M" : "KM"}`;
}

const femaleValues = new Set([
  "f", "fem", "femina", "femenino", "femenina", "mujer", "mujeres", "dama", "damas",
  "female", "woman", "women", "transfemenina", "mujertrans", "senora", "nina",
]);
const maleValues = new Set([
  "m", "masc", "masculino", "masculina", "h", "hombre", "hombres", "varon", "varones",
  "male", "man", "men", "transmasculino", "hombretrans", "senor", "nino",
]);
const otherValues = new Set([
  "otro", "otra", "x", "nobinario", "nobinaria", "nonbinary", "nonbinario", "nonbinaria",
  "intersexual", "intersex", "agenero", "generofluido", "genderfluid",
]);
const noInfoValues = new Set([
  "nd", "na", "sindato", "sininformacion", "noinformado", "noespecificado", "noespecificada",
  "prefieronodecir", "prefieronoresponder", "nosabe", "unknown", "unspecified",
]);

function normalizeSexText(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-CL").replace(/[^a-z0-9]/g, "");
}

export function normalizeAgeBracket(value: string): string | null {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  const normalized = normalizeSexText(cleaned);

  if (/(?:cat(?:egoria)?extra|cat(?:egoria)?especial|especial|sinpremio)/.test(normalized)) {
    return "Categoría especial";
  }

  const range = cleaned.match(/(\d{1,2})\s*(?:a|al|hasta|[-–—])\s*(\d{1,2})(?:\s*(?:años?|anos?))?/i);
  if (range) return `${Number(range[1])} a ${Number(range[2])} años`;

  // Numeric-only values are ages, not brackets, and must not become a category.
  if (/^\d+$/.test(cleaned)) return null;
  if (/\b(?:años?|anos?)\b/i.test(cleaned)) return cleaned;
  return null;
}

export function normalizeParticipantSex(value: string): ParticipantSex | null {
  const normalized = normalizeSexText(value);
  if (!normalized) return null;
  if (femaleValues.has(normalized)) return "F";
  if (maleValues.has(normalized)) return "M";
  if (otherValues.has(normalized)) return "otro";
  if (noInfoValues.has(normalized)) return "no_informado";

  const words = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-CL").match(/[a-z0-9]+/g) ?? [];
  const hasFemale = words.some((word) => femaleValues.has(word));
  const hasMale = words.some((word) => maleValues.has(word));
  if (hasFemale !== hasMale) return hasFemale ? "F" : "M";
  if (words.some((word) => otherValues.has(word))) return "otro";
  return "no_informado";
}

export function categoryWithGender(category: string | null, sex: ParticipantSex | null, ageBracket?: string | null) {
  const bracket = normalizeAgeBracket(ageBracket ?? "") ?? normalizeAgeBracket(category ?? "");
  let baseCategory = category ?? "";
  baseCategory = baseCategory.replace(
    /[\s·|/]*(?:\d{1,2}\s*(?:a|al|hasta|[-–—])\s*\d{1,2}(?:\s*(?:años?|anos?))?|cat\.?\s*(?:extra|especial)|categor[ií]a\s+especial|especial)(?:\s*[·|/-]\s*(?:sin\s+(?:derecho\s+a\s+)?premio))?\s*$/iu,
    "",
  );
  const genderWords = /(^|[^\p{L}\p{N}])(?:f|fem|femenin[oa]|mujer(?:es)?|female|woman|women|señora|niña|damas?|m|masc|masculin[oa]|h|hombres?|var[oó]n(?:es)?|male|man|men|señor|niño)(?=$|[^\p{L}\p{N}])/giu;
  if (sex === "F" || sex === "M") baseCategory = baseCategory.replace(genderWords, "$1");
  baseCategory = baseCategory
    .replace(/^[\s,;:|/·—–-]+|[\s,;:|/·—–-]+$/g, "")
    .replace(/\s*[·|/]+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const genderLabel = sex === "F" ? "Damas" : sex === "M" ? "Varones" : "";
  const podium = [baseCategory, genderLabel].filter(Boolean).join(" ");
  return [podium, bracket].filter(Boolean).join(" · ") || null;
}
