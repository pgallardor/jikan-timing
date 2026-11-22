# Migraciones de Supabase

Las migraciones del esquema viven en `supabase/migrations/`. Se aplican en orden por su marca de tiempo. Los cambios de estructura se guardan como archivos SQL para que el mismo historial pueda desplegarse en cada ambiente.

## Enlazar el proyecto remoto una vez

1. En Supabase, crea o abre el proyecto destino y copia su **Project Ref** desde la URL o la configuración del proyecto.
2. Desde esta carpeta, inicia sesión y enlaza el proyecto:

   ```powershell
   pnpm.cmd supabase login
   pnpm.cmd supabase link --project-ref TU_PROJECT_REF
   ```

   La CLI puede solicitar la contraseña de la base de datos. No la guardes en este repositorio ni la compartas en el chat.

## Flujo para cada cambio de esquema

1. Crea una migración:

   ```powershell
   pnpm.cmd db:new nombre_del_cambio
   ```

2. Edita el SQL creado en `supabase/migrations/`.
3. Revisa el historial y lo que se aplicaría:

   ```powershell
   pnpm.cmd db:status
   pnpm.cmd db:plan
   ```

4. Si el plan muestra solo los cambios esperados, aplícalos:

   ```powershell
   pnpm.cmd db:push
   ```

El comando final aplica únicamente las migraciones locales que faltan en el proyecto enlazado. Conserva los archivos de migración una vez aplicados; no edites migraciones que ya fueron desplegadas, crea una nueva para corregirlas.

## Esquema actual de este proyecto

El historial local contiene 26 archivos de migración, desde `202610020001_initial_schema.sql` hasta `202611220001_event_results_read_only_podiums.sql`. D04 y D07 añaden respuesta durable de ingestión, bloqueo de autoridad local, recibos, historial sanitizado y publicación transaccional; D08 configura la exclusión del top 3 general por distancia. La migración `202611190001_cache_event_podiums.sql` agrega snapshots de puestos por evento e invalida el snapshot cuando cambian marcas, campos de nómina usados por la clasificación o la política de podio. La migración `202611190002_remove_personal_result_qr.sql` retira el RPC de resultados por token individual; el QR de evento abre el standing público. La migración `202611220001_event_results_read_only_podiums.sql` mantiene el cálculo consultado por `event_results` en modo de solo lectura; la actualización diferida del snapshot queda en el RPC público.

La base Supabase local recibió todas las migraciones pendientes registradas hasta el 2026-10-11. La historia local confirma `202610100001_event_ingest_block_reason.sql` como versión aplicada y asigna `202610100002_roster_import_revisions.sql` a la migración de nómina para evitar una colisión de versiones. Las migraciones posteriores del 12 y 18 de octubre, 9 de noviembre y 19 de noviembre se deben contrastar con `db:status` antes de desplegar. Si el proyecto remoto registró la migración de nómina bajo `202610100001`, reconcilia el esquema y el historial antes de continuar. Los participantes, resultados, cuentas de prueba y demás filas locales no se copian con `db push`; ese flujo despliega el esquema.
