"use client";

import { useEffect, useState } from "react";

const tabs = [
  ["results", "Resultados"],
  ["capture", "Captura"],
  ["roster", "Nómina"],
  ["settings", "Configuración"],
  ["reception", "Recepción"],
  ["local", "Operación local"],
  ["history", "Historial"],
] as const;

export default function AdminEventTabs({ eventId, initialTab }: { eventId: string; initialTab?: "roster" }) {
  const storageKey = `admin-event-tab:${eventId}`;
  const [selected, setSelected] = useState<(typeof tabs)[number][0]>(initialTab ?? "results");

  useEffect(() => {
    if (initialTab) {
      try { window.localStorage.setItem(storageKey, initialTab); } catch { /* The explicit tab still works without storage. */ }
      return;
    }
    let saved: string | null = null;
    try { saved = window.localStorage.getItem(storageKey); } catch { return; }
    if (!tabs.some(([id]) => id === saved)) return;
    const timeout = window.setTimeout(() => setSelected(saved as (typeof tabs)[number][0]), 0);
    return () => window.clearTimeout(timeout);
  }, [storageKey, initialTab]);

  useEffect(() => {
    const panels = document.querySelectorAll<HTMLElement>("[data-event-tab-panel]");
    panels.forEach((panel) => { panel.hidden = panel.dataset.eventTabPanel !== selected; });
  }, [selected]);

  return <nav className="event-tabs" aria-label="Secciones del evento">
    {tabs.map(([id, label]) => <button
      key={id}
      type="button"
      className={selected === id ? "active" : ""}
      aria-pressed={selected === id}
      onClick={() => {
        setSelected(id);
        try { window.localStorage.setItem(storageKey, id); } catch { /* The tab still works without browser storage. */ }
      }}
    >{label}</button>)}
  </nav>;
}
