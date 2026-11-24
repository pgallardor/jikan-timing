"use client";
import { useId, useState } from "react";
import { ageGroupValue, categoryLabel } from "@/lib/classification";
export default function ParticipantCategoryFields({ distances, catalog, initialDistance, initialSex = null, initialAgeBracket = null, disabled = false }: {
  distances:string[]; catalog:Record<string,string[]>; initialDistance?:string|null; initialSex?:string|null; initialAgeBracket?:string|null; disabled?:boolean;
}) {
  const id = useId();
  const [distance,setDistance]=useState(initialDistance === undefined ? distances[0] ?? "" : initialDistance ?? "");
  const [sex,setSex]=useState(initialSex ?? "");
  const [bracket,setBracket]=useState(initialAgeBracket ?? "");
  const label=categoryLabel({sex,age_bracket:bracket});
  return <>
    <label>Distancia<select name="distance" value={distance} onChange={(e)=>setDistance(e.target.value)} disabled={disabled} required><option value="">Selecciona distancia</option>{distances.map((d)=><option key={d}>{d}</option>)}</select></label>
    <label>Sexo<select name="sex" value={sex} onChange={(e)=>setSex(e.target.value)} disabled={disabled}><option value="">Sin informar</option><option value="F">Femenino</option><option value="M">Masculino</option><option value="otro">Otro</option><option value="no_informado">No informado</option></select></label>
    <label>Grupo etario<input name="age_bracket" list={id} value={bracket} onChange={(e)=>setBracket(e.target.value)} disabled={disabled} placeholder="Selecciona o escribe un grupo etario" /><datalist id={id}>{(catalog[distance] ?? []).map((b)=><option key={b} value={b} />)}</datalist></label>
    <div role="status"><strong>Categoría calculada</strong><p>{label ?? "Sin categoría: completa sexo y grupo etario"}</p><small>Se calcula por sexo y grupo etario dentro de la distancia.{bracket && !ageGroupValue(bracket) ? " Revisa el rango ingresado." : ""}</small></div>
  </>;
}
