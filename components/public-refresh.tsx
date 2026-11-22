"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { refreshPublicResultsAction } from "@/app/public-actions";

export default function PublicRefresh({ eventSlug }: { eventSlug: string }) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("Pulsa Actualizar para consultar nuevas marcas");

  async function refreshResults() {
    if (refreshing) return;
    setRefreshing(true);
    setMessage("Actualizando resultados…");
    try {
      await refreshPublicResultsAction(eventSlug);
      router.refresh();
      const time = new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit" }).format(new Date());
      setMessage("Consulta actualizada · " + time);
    } catch {
      setMessage("No se pudo actualizar. Intenta nuevamente.");
    } finally {
      setRefreshing(false);
    }
  }

  return <div className="public-refresh" aria-live="polite">
    <button type="button" onClick={refreshResults} disabled={refreshing} aria-label="Actualizar resultados">
      {refreshing ? "Actualizando…" : "Actualizar"}
    </button>
    <span>{message}</span>
  </div>;
}
