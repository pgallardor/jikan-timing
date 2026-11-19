"use client";

export default function PrintButton() {
  return <button className="button button-dark button-small" type="button" onClick={() => window.print()}>Imprimir / guardar PDF</button>;
}
