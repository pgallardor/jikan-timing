"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import QRCode from "qrcode";

type QrPerson = { path: string; bib: string | null; displayName: string; category: string | null };

export default function QrPrintGrid({ participants }: { participants: QrPerson[] }) {
  const [images, setImages] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    const origin = window.location.origin;
    Promise.all(participants.map(async (person) => {
      const value = await QRCode.toDataURL(origin + person.path, {
        width: 240, margin: 1, errorCorrectionLevel: "M",
        color: { dark: "#12201b", light: "#ffffff" },
      });
      return [person.path, value] as const;
    })).then((pairs) => { if (active) setImages(Object.fromEntries(pairs)); });
    return () => { active = false; };
  }, [participants]);
  return <div className="qr-grid">
    {participants.map((person) => <article className="qr-card" key={person.path}>
      {images[person.path] ? <Image src={images[person.path]} alt={"QR de " + person.displayName} width={132} height={132} unoptimized /> : <span className="qr-placeholder">Generando QR…</span>}
      <strong>{person.displayName}</strong>
      <small>{[person.bib ? "Dorsal " + person.bib : null, person.category].filter(Boolean).join(" · ")}</small>
    </article>)}
  </div>;
}
