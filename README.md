# Crono · cronometraje local

App Router de Next.js y Supabase local para llevar eventos de carrera, nóminas, marcas, resultados y un QR por evento. Los datos viven en el Postgres local; no se necesita un proyecto alojado.

## Arranque local

Requiere Node.js 20.9 o superior, pnpm y Docker Desktop en ejecución.

1. Desde esta carpeta, instala las dependencias: **pnpm install**.
2. Inicia el stack local (la primera vez descarga imágenes): **pnpm supabase start**.
3. Aplica las migraciones: **pnpm supabase db reset**.
4. Copia .env.example a .env.local y reemplaza NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY por la clave publicable que muestra **pnpm supabase status**.
5. Inicia la web: **pnpm dev**.
6. Abre [http://localhost:3000](http://localhost:3000) y crea una cuenta desde “Crear cuenta”.

En producción configura `NEXT_PUBLIC_ALLOW_SIGNUP=false` para ocultar el registro en la web y desactiva también “Allow new users to sign up” en Supabase Auth. Las operaciones de administración requieren una cuenta existente.

Supabase Studio queda en [http://127.0.0.1:54323](http://127.0.0.1:54323). Las cuentas de Supabase Auth locales no requieren confirmar correo. Mailpit está disponible en [http://127.0.0.1:54324](http://127.0.0.1:54324) si luego se habilitan confirmaciones.

Inicia la función de ingestión en otra terminal cuando quieras conectar o enviar una marca de prueba: **pnpm supabase functions serve ingest**. El endpoint local será http://127.0.0.1:54321/functions/v1/ingest.

## Lo que incluye esta primera versión

- Autenticación por correo y contraseña. RLS aísla los eventos del usuario que los crea.
- Eventos independientes con zona horaria, estado y opciones de privacidad del standing público. El umbral RSSI se configura y aplica localmente en RFIDTiming.
- Nómina editable y carga CSV con coma o punto y coma. La plantilla está en public/nomina-plantilla.csv; columnas: dorsal, chip, nombre, apellido, sexo, categoría y equipo. La importación valida los duplicados de dorsal y chip y aplica el lote en una transacción.
- Salida/llegada manuales con hora local del evento, motivo obligatorio y anulación/corrección auditable.
- Cálculo de estados SIN CHIP, SIN SALIDA, EN CARRERA, DNF y FINALIZÓ; el organizador puede marcar en lote como DNF a todos los participantes sin llegada. Puestos general/categoría y empates con la misma posición.
- Standing público por evento en `/e/<slug>`, consultable sin cuenta. El QR del evento apunta a ese enlace y puede imprimirse desde administración. Supabase conserva por evento un snapshot de puestos general/categoría y lo invalida cuando cambian marcas, nómina o políticas de podio; Next.js reutiliza las consultas públicas durante 60 segundos. El botón **Actualizar** expira la consulta pública del evento antes de volver a cargarla; no hay refresco automático. Los resultados están visibles durante la carrera y después del cierre; el estado `Publicado` no habilita ni bloquea la consulta.
- Buscador del standing por nombre o apellido, dorsal o categoría; ignora mayúsculas y tildes.
- Un único QR por evento para abrir el standing público. Por defecto se muestra el nombre y apellido, dorsal y categoría en el standing; el administrador puede ocultar cada dato. No se exponen RUT, chip/EPC, correo ni credenciales.
- RFIDTiming inicia sesión con la cuenta que administra el evento. La plataforma comprueba que el usuario sea propietario y registra internamente el UUID del lector al recibir su primera lectura; no requiere alta manual del dispositivo en la web.
- Edge Function ingest: comprueba la sesión y la propiedad del evento, valida el payload y usa reading_id idempotente. La plataforma no vuelve a aplicar un umbral RSSI. Entre marcas RFID de la misma etapa se conserva la de menor captured_at; el orden de llegada HTTP no decide el tiempo. Una corrección manual queda como marca vigente hasta que el operador la anule.
- Exportación de resultados a CSV.

## Payload para el lector

RFIDTiming envía POST con `apikey: <clave publicable>` y `Authorization: Bearer <sesión del usuario administrador>` junto con un cuerpo JSON:

    {
      "event_id": "UUID del evento",
      "device_id": "UUID estable del perfil RFIDTiming",
      "reading_id": "UUID estable para reintentos",
      "stage": "start",
      "epc": "9784",
      "captured_at": "2026-10-02T13:15:00.000Z",
      "antenna": 1,
      "rssi": -48,
      "sequence": 129
    }

La respuesta contiene accepted, duplicate, later_than_current, manual_override, unknown_chip, event_closed, invalid o unauthorized. Un reintento con el mismo device_id y reading_id responde duplicate e incluye el estado original, sin crear otra marca.

## Alcance y siguientes decisiones

RFIDTiming integra el envío con outbox durable, aplica localmente el umbral RSSI y usa la sesión renovable del usuario propietario del evento para autorizar al lector. RFIDLocal conserva sus propias plantillas de mapeo de nómina y su flujo local; esta actualización no cambia esa lógica. La plataforma todavía no incluye colaboración multiusuario por evento, duplicación de eventos ni cargas masivas de correcciones. La configuración de Auth permite alta local para facilitar el primer acceso: antes de un despliegue público, cierra el registro libre y define los permisos por evento.

La matriz de capacidades y brechas entre RFID Local Race y esta app está en [`docs/HOMOLOGACION_FUNCIONAL_RFIDLOCAL_WEB.md`](../docs/HOMOLOGACION_FUNCIONAL_RFIDLOCAL_WEB.md).

Para reiniciar el entorno de datos local de cero, **pnpm supabase db reset** elimina y vuelve a crear los datos locales, conservando la definición versionada en supabase/migrations.

Para cargar un ejemplo local de 15 corredores (12 con tiempo, uno en carrera, uno sin salida y uno sin chip), ejecuta **pnpm supabase db query --local --file supabase/seed_demo.sql**. Abre `/e/demo-vuelta-parque` y prueba, por ejemplo, `alvaro`, `203`, `damas` o una búsqueda sin coincidencias. El fixture no se carga automáticamente al reiniciar Supabase y no forma parte de la nómina real.
