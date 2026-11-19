import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Resultados Ticketnexo | Cronometraje de carreras",
  description: "Eventos, cronometraje RFID y resultados de carrera con Resultados Ticketnexo.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es"><body>{children}</body></html>;
}
