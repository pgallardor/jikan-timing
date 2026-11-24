"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { changeParticipantAction } from "@/app/actions";
import ParticipantCategoryFields from "@/components/participant-category-fields";
import { formatDateTime } from "@/lib/format";

type Person = {
  id: string; bib: string | null; chip: string | null; first_name: string; last_name: string | null;
  sex: string | null; rut: string | null; distance: string | null; age: number | null;
  age_bracket: string | null; category: string | null; team: string | null; dnf_at: string | null;
};

function SaveButton({ finishedDnf }: { finishedDnf: boolean }) {
  const { pending } = useFormStatus();
  return <button className={"button button-small " + (finishedDnf ? "button-danger" : "button-dark")} disabled={pending}>{pending ? "Guardando…" : finishedDnf ? "Confirmar DNF con llegada" : "Confirmar cambio"}</button>;
}

export default function ParticipantActions({ eventId, person, distances, categoryCatalog, finishAt, timeZone, disabled }: {
  eventId: string; person: Person; distances: string[]; categoryCatalog: Record<string,string[]>; finishAt: string | null; timeZone: string; disabled: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [operation, setOperation] = useState("update");
  const { id, ...expected } = person;
  const finishedDnf = operation === "dnf" && Boolean(finishAt);
  const title = operation === "update" ? "Editar corredor" : operation === "remove" ? "Dar de baja" : finishedDnf ? "Marcar DNF a un corredor con llegada" : operation === "dnf" ? "Marcar DNF" : "Quitar DNF";
  function open(value: string) { setOperation(value); dialog.current?.showModal(); }
  return <div className="participant-actions">
    <button type="button" className="button button-quiet button-small" disabled={disabled} onClick={() => open("update")}>Editar</button>
    <button type="button" className="button button-quiet button-small" disabled={disabled} onClick={() => open(person.dnf_at ? "clear_dnf" : "dnf")}>{person.dnf_at ? "Quitar DNF" : "Marcar DNF"}</button>
    <button type="button" className="button button-danger button-small" disabled={disabled} onClick={() => open("remove")}>Dar de baja</button>
    <dialog ref={dialog} className="operator-dialog" aria-labelledby={"participant-dialog-" + id}>
      <div className="operator-dialog-heading"><h2 id={"participant-dialog-" + id}>{title}</h2><button type="button" className="button button-quiet button-small" onClick={() => dialog.current?.close()}>Cerrar</button></div>
      <p>#{person.bib ?? "Sin dorsal"} · {person.first_name} {person.last_name}</p>
      <form action={changeParticipantAction} key={operation}>
        <input type="hidden" name="event_id" value={eventId} /><input type="hidden" name="participant_id" value={id} />
        <input type="hidden" name="operation" value={operation} /><input type="hidden" name="expected" value={JSON.stringify(expected)} />
        {operation === "dnf" && <input type="hidden" name="expected_finish_at" value={finishAt ?? ""} />}
        {operation === "update" && <div className="operator-edit-grid">
          <label>Dorsal<input name="bib" defaultValue={person.bib ?? ""} /></label>
          <label>Chip / EPC<input name="chip" defaultValue={person.chip ?? ""} /></label>
          <label>Nombre<input name="first_name" defaultValue={person.first_name} maxLength={100} required /></label>
          <label>Apellido<input name="last_name" defaultValue={person.last_name ?? ""} /></label>
          <ParticipantCategoryFields distances={distances} catalog={categoryCatalog} initialDistance={person.distance} initialSex={person.sex} initialAgeBracket={person.age_bracket} disabled={disabled} />
          <label>Edad<input name="age" type="number" min={0} max={120} defaultValue={person.age ?? ""} /></label>
          <label>Equipo<input name="team" defaultValue={person.team ?? ""} /></label>
          <label>RUT (privado)<input name="rut" defaultValue={person.rut ?? ""} /></label>
        </div>}
        {operation === "remove" && <><p>El corredor dejará de aparecer en la nómina y los resultados. Se conservará una copia de sus datos, marcas e historial en la auditoría.</p><label className="check-label"><input type="checkbox" name="confirm_remove" required />Confirmo dar de baja a este corredor</label></>}
        {finishedDnf ? <div className="finished-dnf-confirmation" role="note">
          <p><strong>Este corredor tiene una llegada registrada:</strong> {formatDateTime(finishAt, timeZone)}.</p>
          <p>Al confirmar quedará como DNF y dejará de contar como finalizado y de participar en los podios. Su salida, llegada y tiempo se conservarán para la auditoría.</p>
          <label className="check-label"><input type="checkbox" name="confirm_finished_dnf" required />Confirmo marcar DNF a este corredor pese a su llegada registrada</label>
        </div> : operation === "dnf" && <p>El corredor se mostrará como DNF. Puedes quitar este estado desde la nómina si necesita continuar.</p>}
        {operation === "clear_dnf" && finishAt && <p>Al quitar DNF, el resultado volverá a calcularse con las marcas conservadas. Si tiene una salida y llegada válidas, volverá a contar como finalizado y a participar en los podios.</p>}
        <label>Motivo para el historial<input name="reason" minLength={3} maxLength={200} required placeholder="Describe por qué haces este cambio" /></label>
        <div className="operator-dialog-footer"><SaveButton finishedDnf={finishedDnf} /></div>
      </form>
    </dialog>
  </div>;
}
