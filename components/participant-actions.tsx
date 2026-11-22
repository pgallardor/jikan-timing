"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { changeParticipantAction } from "@/app/actions";
import ParticipantCategoryFields from "@/components/participant-category-fields";
import { participantBaseCategory, type CategoryCatalog } from "@/lib/category-options";

type Person = {
  id: string; bib: string | null; chip: string | null; first_name: string; last_name: string | null;
  sex: string | null; rut: string | null; distance: string | null; age: number | null;
  age_bracket: string | null; category: string | null; team: string | null; dnf_at: string | null;
};

function SaveButton() {
  const { pending } = useFormStatus();
  return <button className="button button-dark button-small" disabled={pending}>{pending ? "Guardando…" : "Confirmar cambio"}</button>;
}

export default function ParticipantActions({ eventId, person, distances, categoryCatalog, hasFinish, disabled }: {
  eventId: string; person: Person; distances: string[]; categoryCatalog: CategoryCatalog; hasFinish: boolean; disabled: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [operation, setOperation] = useState("update");
  const { id, ...expected } = person;
  const baseCategory = participantBaseCategory(person.category, person.age_bracket);
  const title = operation === "update" ? "Editar corredor" : operation === "remove" ? "Dar de baja" : operation === "dnf" ? "Marcar DNF" : "Quitar DNF";
  function open(value: string) { setOperation(value); dialog.current?.showModal(); }
  return <div className="participant-actions">
    <button type="button" className="button button-quiet button-small" disabled={disabled} onClick={() => open("update")}>Editar</button>
    <button type="button" className="button button-quiet button-small" disabled={disabled || (hasFinish && !person.dnf_at)} title={hasFinish ? "Anula primero la llegada para marcar DNF" : undefined} onClick={() => open(person.dnf_at ? "clear_dnf" : "dnf")}>{person.dnf_at ? "Quitar DNF" : "Marcar DNF"}</button>
    <button type="button" className="button button-danger button-small" disabled={disabled} onClick={() => open("remove")}>Dar de baja</button>
    <dialog ref={dialog} className="operator-dialog" aria-labelledby={"participant-dialog-" + id}>
      <div className="operator-dialog-heading"><h2 id={"participant-dialog-" + id}>{title}</h2><button type="button" className="button button-quiet button-small" onClick={() => dialog.current?.close()}>Cerrar</button></div>
      <p>#{person.bib ?? "Sin dorsal"} · {person.first_name} {person.last_name}</p>
      <form action={changeParticipantAction} key={operation}>
        <input type="hidden" name="event_id" value={eventId} /><input type="hidden" name="participant_id" value={id} />
        <input type="hidden" name="operation" value={operation} /><input type="hidden" name="expected" value={JSON.stringify(expected)} />
        {operation === "update" && <div className="operator-edit-grid">
          <label>Dorsal<input name="bib" defaultValue={person.bib ?? ""} /></label>
          <label>Chip / EPC<input name="chip" defaultValue={person.chip ?? ""} /></label>
          <label>Nombre<input name="first_name" defaultValue={person.first_name} maxLength={100} required /></label>
          <label>Apellido<input name="last_name" defaultValue={person.last_name ?? ""} /></label>
          <label>Sexo<select name="sex" defaultValue={person.sex ?? ""}><option value="">Sin informar</option><option value="F">Femenino</option><option value="M">Masculino</option><option value="otro">Otro</option><option value="no_informado">No informado</option></select></label>
          <ParticipantCategoryFields distances={distances} catalog={categoryCatalog} initialDistance={person.distance} initialCategory={baseCategory} disabled={disabled} />
          <label>Edad<input name="age" type="number" min={0} max={120} defaultValue={person.age ?? ""} /></label>
          <label>Grupo etario<input name="age_bracket" defaultValue={person.age_bracket ?? ""} /></label>
          <label>Equipo<input name="team" defaultValue={person.team ?? ""} /></label>
          <label>RUT (privado)<input name="rut" defaultValue={person.rut ?? ""} /></label>
        </div>}
        {operation === "remove" && <><p>El corredor dejará de aparecer en la nómina y los resultados. Se conservará una copia de sus datos, marcas e historial en la auditoría.</p><label className="check-label"><input type="checkbox" name="confirm_remove" required />Confirmo dar de baja a este corredor</label></>}
        {operation === "dnf" && <p>El corredor se mostrará como DNF. Puedes quitar este estado desde la nómina si necesita continuar.</p>}
        <label>Motivo para el historial<input name="reason" minLength={3} maxLength={200} required placeholder="Describe por qué haces este cambio" /></label>
        <div className="operator-dialog-footer"><SaveButton /></div>
      </form>
    </dialog>
  </div>;
}
