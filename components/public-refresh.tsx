"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function PublicRefresh() {
  const router = useRouter();
  const [seconds, setSeconds] = useState(15);
  useEffect(() => {
    let remaining = 15;
    const timer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        router.refresh();
        remaining = 15;
      }
      setSeconds(remaining);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [router]);
  return <span className="public-refresh" aria-live="off">Actualiza en {seconds} s</span>;
}
