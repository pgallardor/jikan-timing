"use client";

import { useMemo, useState } from "react";
import { normalizeDistance } from "@/lib/participant-category";
import { createEventAction } from "@/app/actions";

export default function EventSetupForm() {
  const [distancesText, setDistancesText] = useState("10KM, 21KM");
  const distances = useMemo(() => [...new Set(distancesText.split(/[\n,;]+/)
    .map((value) => normalizeDistance(value)).filter((value): value is string => Boolean(value)))], [distancesText]);

  return <form action={createEventAction} className="stack-form">
    <label>Nombre del evento<input name="name" placeholder="Corrida del Puerto 2026" minLength={2} maxLength={120} required /></label>
    <label>Organización <span className="optional">(opcional)</span><input name="organizer" placeholder="Club o municipio" /></label>
    <label>Fecha de la carrera <span className="optional">(opcional)</span><input name="event_date" type="date" /></label>
    <label>Zona horaria<select name="timezone" defaultValue="America/Santiago"><option value="America/Santiago">Chile continental · Santiago</option><option value="America/Punta_Arenas">Magallanes · Punta Arenas</option><option value="Pacific/Easter">Isla de Pascua</option><option value="UTC">UTC</option></select></label>
    <label>Distancias del evento<input value={distancesText} onChange={(event) => setDistancesText(event.target.value)} placeholder="3KM, 10KM, 21KM" required /></label>
    {distances.length === 0 ? <p className="setting-caption">Ingresa al menos una distancia válida.</p> : <fieldset className="distance-policy-fields">
      <legend>Política por distancia</legend>
      <p className="setting-caption">Define antes de cargar la nómina si los tres primeros de la general por sexo se excluyen de los podios de categoría y grupo etario.</p>
      {distances.map((distance) => <label key={distance}>{distance}
        <input type="hidden" name="distance" value={distance} />
        <select name={`distance_policy_${distance}`} defaultValue="" required>
          <option value="">Elegir política…</option><option value="false">No excluir</option><option value="true">Excluir top 3 general</option>
        </select>
      </label>)}
    </fieldset>}
    <button className="button button-dark button-full" disabled={distances.length === 0}>Crear evento <span aria-hidden="true">→</span></button>
  </form>;
}
