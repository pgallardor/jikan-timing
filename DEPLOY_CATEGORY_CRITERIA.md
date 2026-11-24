# Despliegue de categorías por criterios

Migración: `202611230001_category_criteria.sql`. Motor offline compatible: `category_criteria_v1@1`. La categoría se obtiene de sexo y grupo etario dentro de cada distancia; la etiqueta importada queda como antecedente.

## Validación y datos

Se respaldaron esquema y datos públicos actuales de producción en `local-backups/production-category-criteria-20261123/`, excluido de Git. Los respaldos se restauraron en un contenedor sin red. Se verificaron los 1681 resultados contra el motor C# y se ensayó una reversión completa que recuperó los campos y puestos originales y las 1953 marcas. También pasaron 15 pruebas de lógica, 20 escenarios de integración (incluido un lote de 5000 llegadas), seis casos de conversión de datos antiguos, ESLint y las compilaciones web y RFID Local.

La preparación antigua de **GTVUT 2026** se liberó con autorización expresa del operador. Para ese evento hay que descargar una preparación nueva usando el cliente compatible; los paquetes del motor anterior se rechazan explícitamente.

La migración tiene `BEGIN/COMMIT` explícitos, bloquea preparaciones pendientes y avisa a PostgREST para recargar el esquema. Recuperó una sola vez 149 grupos etarios inequívocos y conserva cada conversión en `category_criteria_conversion_audit`, con RLS de propietario. Los 34 registros incompletos restantes pertenecen a dos eventos cancelados: 31 sin distancia y 3 definidos solo como general. La clasificación en ejecución no interpreta nombres.

Se conservaron los 1681 participantes, las 1953 marcas y todos los estados/puestos generales. La comparación posterior a la migración coincidió con los resultados del ensayo. El original `crono-local` no se modificó. Las primeras comprobaciones de despliegue se detuvieron antes de modificar el esquema; se corrigieron el archivo de guard y la transacción explícita antes de aplicar la migración.

## Reversión preparada

Los siguientes comandos corresponden a este despliegue y requieren los respaldos privados conservados en el equipo del operador. No restauran un dump completo sobre datos recientes.

```powershell
pnpm exec supabase db query --linked --file local-backups/production-category-criteria-20261123/rollback-before.sql --output json
vercel rollback dpl_AYCUEheqDBxMPFZ8F3FGCBDcg4FR --yes
```

El SQL restaura los campos convertidos, las funciones/vista originales, los permisos y el estado anterior de la preparación; conserva las auditorías en un esquema privado e invalida los snapshots. Se rechaza si aparecen preparaciones nuevas o si se editaron los criterios de filas convertidas, para evitar sobrescribir actividad posterior. En ese caso hay que conservar y reconciliar esas ediciones antes de revertir. El estado de Vercel anterior está guardado en `vercel-before.json` dentro del mismo respaldo.

Después de revertir se comparan marcas, estados y puestos con `before.json`, se verifica el standing HTTP y se revierte también el commit del despliegue en Git para que una publicación posterior no reintroduzca el cambio. La rama `codex/category-criteria-synthetic` conserva la implementación para revisión.
