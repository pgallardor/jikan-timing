"use client";

import { useMemo, useState } from "react";
import { formatDuration } from "@/lib/format";
import { normalizeDistance } from "@/lib/participant-category";

type ResultRow = {
  participant_id: string;
  bib: string | null;
  first_name: string | null;
  last_name: string | null;
  team: string | null;
  category: string | null;
  distance: string | null;
  sex: string | null;
  elapsed_seconds: number | null;
  overall_place: number | null;
  category_place: number | null;
};

function sexOrder(value: string | null) {
  if (value === "F") return 1;
  if (value === "M") return 2;
  if (value === "otro") return 3;
  if (value === "no_informado") return 4;
  return 5;
}

function sexLabel(value: string | null) {
  if (value === "F") return "Damas";
  if (value === "M") return "Varones";
  if (value === "otro") return "Otro";
  if (value === "no_informado") return "No informado";
  return "Sin sexo";
}

export default function AdminResultsTable({ participants }: { participants: ResultRow[] }) {
  const [selectedDistance, setSelectedDistance] = useState("");
  const distances = useMemo(() => [...new Set(
    participants.map((person) => normalizeDistance(person.distance ?? "")).filter((distance): distance is string => Boolean(distance)),
  )].sort((left, right) => left.localeCompare(right, "es-CL", { sensitivity: "base", numeric: true })), [participants]);
  const filtered = useMemo(() => participants
    .filter((person) => !selectedDistance || normalizeDistance(person.distance ?? "") === selectedDistance)
    .sort((left, right) => {
      const distanceOrder = (normalizeDistance(left.distance ?? "") ?? "").localeCompare(normalizeDistance(right.distance ?? "") ?? "", "es-CL", { sensitivity: "base", numeric: true });
      return distanceOrder
        || sexOrder(left.sex) - sexOrder(right.sex)
        || Number(left.overall_place ?? Infinity) - Number(right.overall_place ?? Infinity)
        || Number(left.elapsed_seconds ?? Infinity) - Number(right.elapsed_seconds ?? Infinity);
    }), [participants, selectedDistance]);

  return <>
    <div className="results-distance-tools">
      <label className="results-distance-filter">
        <span>Filtrar distancia</span>
        <select value={selectedDistance} onChange={(event) => setSelectedDistance(event.target.value)} aria-label="Filtrar resultados por distancia">
          <option value="">Todas las distancias</option>
          {distances.map((distance) => <option key={distance} value={distance}>{distance}</option>)}
        </select>
      </label>
      <span className="standing-count" aria-live="polite">{filtered.length} de {participants.length} tiempos completos</span>
    </div>
    <div className="table-wrap"><table className="data-table"><thead><tr><th>General dist./sexo</th><th>Dorsal</th><th>Corredor</th><th>Distancia</th><th>Sexo</th><th>Categoría</th><th>Estado</th><th>Tiempo</th></tr></thead><tbody>
      {filtered.length ? filtered.map((person) => <tr key={person.participant_id}>
        <td className="bib-cell">{person.overall_place ?? "—"} <small> / cat. {person.category_place ?? "—"}</small></td>
        <td>{person.bib || "—"}</td><td className="person-cell"><strong>{[person.first_name, person.last_name].filter(Boolean).join(" ") || "Participante"}</strong><small>{person.team || "Sin equipo"}</small></td>
        <td>{normalizeDistance(person.distance ?? "") || "—"}</td><td>{sexLabel(person.sex)}</td><td>{person.category || "—"}</td><td><span className="result-tag result-finalizó">FINALIZÓ</span></td><td className="bib-cell">{formatDuration(Number(person.elapsed_seconds))}</td>
      </tr>) : <tr><td colSpan={8} className="muted">Los tiempos y puestos aparecerán cuando existan marcas de salida y llegada.</td></tr>}
    </tbody></table></div>
  </>;
}
