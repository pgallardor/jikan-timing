"use client";

import { useMemo, useState } from "react";
import { formatDuration } from "@/lib/format";
import { normalizeDistance } from "@/lib/participant-category";

type PublicStandingRow = {
  participant_name: string | null;
  bib: string | null;
  category: string | null;
  distance: string | null;
  sex: string | null;
  result_status: string | null;
  elapsed_seconds: number | null;
  overall_place: number | null;
  category_place: number | null;
};

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-CL");
}

const UNCATEGORIZED = "__uncategorized__";
const NO_DISTANCE = "Sin distancia";
const SEX_ORDER = ["F", "M", "otro", "no_informado", ""];

function sexLabel(value: string | null) {
  if (value === "F") return "Damas";
  if (value === "M") return "Varones";
  if (value === "otro") return "Otro";
  if (value === "no_informado") return "No informado";
  return "Sin sexo";
}

function raceGroupKey(distance: string | null, sex: string | null) {
  return JSON.stringify([distance ?? "", sex ?? ""]);
}

function subcategoryLabel(category: string | null) {
  if (!category?.trim()) return null;

  const label = category
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kms?|k|metros?|m)\b/giu, " ")
    .replace(/(^|[^\p{L}\p{N}])(?:f|fem|femenin[oa]|mujer(?:es)?|female|woman|women|señora|niña|damas?|m|masc|masculin[oa]|h|hombres?|var[oó]n(?:es)?|male|man|men|señor|niño)(?=$|[^\p{L}\p{N}])/giu, "$1")
    .replace(/[|/]+/g, " · ")
    .replace(/[;,]+/g, " ")
    .replace(/[—–]+/g, "-")
    .replace(/\s*·\s*/g, " · ")
    .replace(/^\s*[·-]\s*|\s*[·-]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return label || "General";
}

export default function PublicStandingTable({ participants }: { participants: PublicStandingRow[] }) {
  const [query, setQuery] = useState("");
  const [selectedRaceGroup, setSelectedRaceGroup] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const raceGroups = useMemo(() => {
    const groups = new Map<string, { distance: string; sex: string; key: string }>();
    for (const person of participants) {
      const distance = normalizeDistance(person.distance ?? "") ?? "";
      const sex = person.sex ?? "";
      const key = raceGroupKey(distance, sex);
      groups.set(key, { distance, sex, key });
    }

    return [...groups.values()].sort((left, right) => {
      const distanceOrder = (left.distance || NO_DISTANCE).localeCompare(right.distance || NO_DISTANCE, "es-CL", { sensitivity: "base", numeric: true });
      return distanceOrder || SEX_ORDER.indexOf(left.sex) - SEX_ORDER.indexOf(right.sex);
    });
  }, [participants]);
  const selectedGroup = raceGroups.find((group) => group.key === selectedRaceGroup);
  const categoryParticipants = selectedGroup
    ? participants.filter((person) => raceGroupKey(normalizeDistance(person.distance ?? ""), person.sex) === selectedGroup.key)
    : participants;
  const categories = useMemo(() => [...new Set(
    categoryParticipants.map((person) => subcategoryLabel(person.category)).filter((category): category is string => Boolean(category)),
  )].sort((left, right) => left.localeCompare(right, "es-CL", { sensitivity: "base", numeric: true })), [categoryParticipants]);
  const hasUncategorized = categoryParticipants.some((person) => !subcategoryLabel(person.category));
  const filtered = useMemo(() => {
    const needle = normalize(query.trim());
    return participants.filter((person) => {
      if (selectedRaceGroup && raceGroupKey(normalizeDistance(person.distance ?? ""), person.sex) !== selectedRaceGroup) return false;
      if (selectedCategory === UNCATEGORIZED && subcategoryLabel(person.category)) return false;
      if (selectedCategory && selectedCategory !== UNCATEGORIZED && subcategoryLabel(person.category) !== selectedCategory) return false;
      if (!needle) return true;
      return normalize([
        person.participant_name,
        person.bib,
        person.category,
      ].filter(Boolean).join(" ")).includes(needle);
    });
  }, [participants, query, selectedRaceGroup, selectedCategory]);
  const hasActiveFilters = Boolean(query.trim() || selectedRaceGroup || selectedCategory);

  return <>
    <div className="standing-tools">
      <label className="standing-search">
        <span>Buscar por nombre o apellido</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Nombre o apellido, dorsal o categoría"
          aria-label="Buscar por nombre o apellido, dorsal o categoría"
        />
      </label>
      <label className="standing-distance-filter">
        <span>Filtrar distancia y sexo</span>
        <select value={selectedRaceGroup} onChange={(event) => { setSelectedRaceGroup(event.target.value); setSelectedCategory(""); }} aria-label="Filtrar por distancia y sexo">
          <option value="">Todas las distancias y sexos</option>
          {raceGroups.map((group) => <option key={group.key} value={group.key}>{group.distance || NO_DISTANCE} · {sexLabel(group.sex || null)}</option>)}
        </select>
      </label>
      <label className="standing-category-filter">
        <span>Filtrar subcategoría</span>
        <select value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)} aria-label="Filtrar por subcategoría">
          <option value="">Todas las subcategorías</option>
          {categories.map((category) => <option key={category} value={category}>{category}</option>)}
          {hasUncategorized && <option value={UNCATEGORIZED}>Sin subcategoría</option>}
        </select>
      </label>
      <span className="standing-count" aria-live="polite">{filtered.length} de {participants.length} corredores</span>
    </div>

    {filtered.length ? <div className="table-wrap standing-table-wrap">
      <table className="data-table standing-table">
        <thead><tr><th>General</th><th>Dorsal</th><th>Corredor</th><th>Distancia</th><th>Sexo</th><th>Categoría</th><th>Estado</th><th>Tiempo</th></tr></thead>
        <tbody>{filtered.map((person, index) => <tr key={person.bib ?? `${person.participant_name ?? "corredor"}-${index}`}>
          <td className="bib-cell">{person.overall_place ?? "—"}{person.category && person.category_place ? <small>Cat. {person.category_place}</small> : null}</td>
          <td>{person.bib || "—"}</td>
          <td className="person-cell"><strong>{person.participant_name || "Participante"}</strong></td>
          <td>{normalizeDistance(person.distance ?? "") || "—"}</td>
          <td>{sexLabel(person.sex)}</td>
          <td>{person.category || "—"}</td>
          <td><span className={"result-tag " + (person.result_status === "FINALIZÓ" ? "result-finalizó" : person.result_status === "EN CARRERA" ? "result-en-carrera" : person.result_status === "DNF" ? "result-dnf" : "")}>{person.result_status}</span></td>
          <td className="bib-cell">{person.result_status === "DNF" ? "—" : formatDuration(person.elapsed_seconds)}</td>
        </tr>)}</tbody>
      </table>
    </div> : <div className="empty-state standing-empty">
      <span className="empty-icon">CR</span>
      <h3>{hasActiveFilters ? "No encontramos corredores" : "La nómina todavía no está cargada"}</h3>
      <p>{hasActiveFilters ? "Prueba con otra búsqueda o cambia los filtros de distancia, sexo y subcategoría." : "Pulsa Actualizar para consultar de nuevo cuando la organización añada corredores o marcas."}</p>
    </div>}
  </>;
}
