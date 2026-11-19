"use client";

import { useId, useState, type KeyboardEvent } from "react";

export type ArrivalParticipantOption = {
  id: string;
  bib: string | null;
  name: string;
  category: string | null;
  chip: string | null;
  hasStart: boolean;
  hasFinish: boolean;
};

function normalizeSearch(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-CL").trim();
}

function participantLabel(person: ArrivalParticipantOption) {
  return [person.bib ? "#" + person.bib : "Sin dorsal", person.name, person.category || "Sin categoría"]
    .join(" · ");
}

export default function ParticipantPicker({ participants }: { participants: ArrivalParticipantOption[] }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ArrivalParticipantOption | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
  const matches = participants.filter((person) => {
    const haystack = normalizeSearch([
      person.bib ?? "",
      person.name,
      person.category ?? "",
      person.chip ?? "",
      person.hasStart ? "con salida" : "sin salida",
      person.hasFinish ? "con llegada" : "sin llegada",
    ].join(" "));
    return terms.every((term) => haystack.includes(term));
  });
  const visible = matches.slice(0, 8);
  const inputId = "participant-search-" + id;
  const listId = "participant-results-" + id;
  const statusId = "participant-status-" + id;

  function choose(person: ArrivalParticipantOption) {
    setSelected(person);
    setQuery(participantLabel(person));
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, Math.max(visible.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && open && visible.length) {
      event.preventDefault();
      choose(visible[activeIndex] ?? visible[0]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return <div className="participant-picker">
    <label htmlFor={inputId}>Corredor</label>
    <div className="participant-picker-control">
      <input
        id={inputId}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && visible[activeIndex] ? listId + "-" + activeIndex : undefined}
        aria-describedby={statusId}
        autoComplete="off"
        placeholder="Buscar por dorsal, nombre o chip"
        value={query}
        onFocus={() => {
          setOpen(true);
          setActiveIndex(0);
        }}
        onChange={(event) => {
          setSelected(null);
          setQuery(event.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => setOpen(false)}
      />
      {open && <div className="participant-picker-results" id={listId} role="listbox" aria-label="Corredores encontrados">
        {visible.length ? visible.map((person, index) => <button
          className={"participant-picker-option" + (index === activeIndex ? " active" : "")}
          id={listId + "-" + index}
          key={person.id}
          type="button"
          role="option"
          aria-selected={selected?.id === person.id}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => choose(person)}
        >
          <strong>{person.bib ? "#" + person.bib + " · " : ""}{person.name}</strong>
          <small>{person.category || "Sin categoría"} · {person.chip ? "Chip " + person.chip : "Sin chip"} · {person.hasStart ? "Salida registrada" : "Sin salida"} · {person.hasFinish ? "Ya tiene llegada" : "Sin llegada"}</small>
        </button>) : <p className="participant-picker-empty">No hay corredores que coincidan.</p>}
      </div>}
    </div>
    <input type="hidden" name="participant_id" value={selected?.id ?? ""} />
    <small id={statusId} className="participant-picker-status">
      {selected ? (!selected.hasStart ? "No tiene salida; registra primero la hora de largada de su distancia." : selected.hasFinish ? "Ya tiene llegada; al guardar se corregirá con motivo." : "Salida registrada; ingresa el tiempo transcurrido." ) : open ? matches.length + " encontrados · usa ↑ ↓ y Enter para elegir" : "Escribe un dorsal, apellido, nombre o chip y selecciona un resultado."}
    </small>
  </div>;
}
