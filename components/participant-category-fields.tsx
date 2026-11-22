"use client";

import { useState } from "react";
import { categoryAfterDistanceChange, existingCategoryChoice, type CategoryCatalog } from "@/lib/category-options";
import { normalizeDistance } from "@/lib/participant-category";

export default function ParticipantCategoryFields({ distances, catalog, initialDistance, initialCategory = null, disabled = false }: {
  distances: string[]; catalog: CategoryCatalog; initialDistance?: string | null; initialCategory?: string | null; disabled?: boolean;
}) {
  const defaultDistance = initialDistance === undefined ? distances[0] ?? "" : initialDistance ?? "";
  const defaultCategory = categoryAfterDistanceChange(initialCategory, catalog[normalizeDistance(defaultDistance) ?? ""] ?? []) ?? initialCategory;
  const [distance, setDistance] = useState(defaultDistance);
  const [choice, setChoice] = useState(defaultCategory ? existingCategoryChoice(defaultCategory) : "");
  const [previousChoice, setPreviousChoice] = useState(choice);
  const [newName, setNewName] = useState("");
  const options = catalog[normalizeDistance(distance) ?? ""] ?? [];
  return <>
    <label>Distancia<select name="distance" value={distance} disabled={disabled} required onChange={(event) => {
      const next = event.target.value;
      const previous = choice.startsWith("existing:") ? decodeURIComponent(choice.slice("existing:".length)) : null;
      const category = categoryAfterDistanceChange(previous, catalog[normalizeDistance(next) ?? ""] ?? []);
      const nextChoice = category ? existingCategoryChoice(category) : "";
      setDistance(next); setChoice(nextChoice); setPreviousChoice(nextChoice); setNewName("");
    }}><option value="">Selecciona distancia</option>{distances.map((value) => <option key={value}>{value}</option>)}</select></label>
    <div className="participant-category-field">
      <label>Categoría base<select name="category_choice" value={choice} disabled={disabled || !distance} onChange={(event) => {
        const next = event.target.value;
        if (next !== "new") setPreviousChoice(next);
        setChoice(next); setNewName("");
      }}>
        <option value="">(Sin categoría base)</option>
        {options.map((category) => <option key={category} value={existingCategoryChoice(category)}>{category}</option>)}
        <option value="new">Crear otra categoría…</option>
      </select></label>
      {choice === "new" && <div className="new-category-fields">
        <label>Nueva categoría<input name="new_category" value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={120} required disabled={disabled} placeholder="Nombre de la nueva categoría" /></label>
        <button type="button" className="button button-quiet button-small" onClick={() => { setChoice(previousChoice); setNewName(""); }}>Cancelar nueva categoría</button>
        <small>Quedará disponible en esta distancia al guardar el corredor.</small>
      </div>}
    </div>
  </>;
}
