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

### Herramientas del operador — aplicadas en local y producción

`202611220002_web_operator_tools.sql` añade `participant_change_audit` (lectura exclusiva del propietario mediante RLS) y los RPC autenticados `change_event_participant` y `record_manual_finishes_batch`. La edición reutiliza las revisiones existentes de nómina. La baja conserva la fila completa, las marcas y su auditoría antes de retirar al participante activo; las revisiones previas y recibos RFID se conservan. DNF se marca o retira individualmente con motivo. La planilla guarda todas las llegadas y auditorías en una transacción y rechaza cambios de marcas posteriores a la revisión. Ambos RPC comprueban propiedad y autoridad local. El archivo no ejecuta cargas, no cambia las políticas deportivas ni modifica eventos por sí solo.

El 22 de noviembre de 2026 se ejecutó `supabase migration up --local`, autorizado por el operador. Aplicó únicamente las dos versiones locales pendientes: `202611220001` y `202611220002`, sin resetear la base. La consulta posterior confirmó ambas en el historial local. Las pruebas `pnpm test:operator:local` verifican los RPC autenticados y los formularios web contra Postgres local, incluido rollback completo del lote, RLS, conservación de auditoría y retiro de DNF. Incluyen 5000 llegadas en un envío y la lectura paginada de esos resultados para exportar sus podios. Las cuentas/eventos ficticios se eliminan y se comprueba que el conteo de eventos y participantes vuelva al valor previo.

Con autorización posterior del operador, el mismo día se aplicó `supabase db push --linked --yes` al proyecto de producción `nuxjojhynydmizqaigja`, usando la sesión habitual de la CLI fuera de la sandbox. El plan previo mostraba únicamente `202611220002_web_operator_tools.sql`; `202611220001` ya estaba aplicado. El comando no incluyó semillas ni roles. Una segunda revisión con `--dry-run` confirmó que producción quedó al día. La web se despliega automáticamente al hacer push a `main`; se aplica primero el esquema compatible y luego se publica el código. Los siguientes cambios de esquema deben revisarse y contar con autorización antes de aplicarse.

El historial local contiene 27 archivos de migración, desde `202610020001_initial_schema.sql` hasta `202611220002_web_operator_tools.sql`. D04 y D07 añaden respuesta durable de ingestión, bloqueo de autoridad local, recibos, historial sanitizado y publicación transaccional; D08 configura la exclusión del top 3 general por distancia. La migración `202611190001_cache_event_podiums.sql` agrega snapshots de puestos por evento e invalida el snapshot cuando cambian marcas, campos de nómina usados por la clasificación o la política de podio. La migración `202611190002_remove_personal_result_qr.sql` retira el RPC de resultados por token individual; el QR de evento abre el standing público. La migración `202611220001_event_results_read_only_podiums.sql` mantiene el cálculo consultado por `event_results` en modo de solo lectura; la actualización diferida del snapshot queda en el RPC público.

La base Supabase local recibió todas las migraciones versionadas hasta `202611220002` el 22 de noviembre de 2026. La historia local confirma `202610100001_event_ingest_block_reason.sql` como versión aplicada y asigna `202610100002_roster_import_revisions.sql` a la migración de nómina para evitar una colisión de versiones. El historial remoto se debe contrastar con `db:status` antes de cualquier despliegue autorizado. Si el proyecto remoto registró la migración de nómina bajo `202610100001`, reconcilia el esquema y el historial antes de continuar. Los participantes, resultados, cuentas de prueba y demás filas locales no se copian con `db push`; ese flujo despliega el esquema.
