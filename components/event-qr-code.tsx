"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import QRCode from "qrcode";

export default function EventQrCode({ eventPath, eventName }: { eventPath: string; eventName: string }) {
  const [image, setImage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(window.location.origin + eventPath, {
      width: 320,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#12201b", light: "#ffffff" },
    }).then((value) => { if (active) setImage(value); });
    return () => { active = false; };
  }, [eventPath]);

  return <div className="event-qr-wrap">
    <article className="qr-card event-qr-card">
      {image ? <Image src={image} alt={"QR del evento " + eventName} width={240} height={240} unoptimized /> : <span className="qr-placeholder">Generando QR…</span>}
      <strong>{eventName}</strong>
      <small>Standing público</small>
      <a className="download-link" href={eventPath}>{eventPath}</a>
    </article>
  </div>;
}
