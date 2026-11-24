# Categorías por criterios: prueba aislada

Rama en web y RFID Local: `codex/category-criteria-synthetic`. Los scripts de este documento solo operan sobre la base sintética; nunca migran producción ni la base anterior `crono-local`.

## Comportamiento

- Dentro de cada distancia, la categoría corresponde a los valores normalizados de sexo y grupo etario. El nombre es una representación calculada.
- `30-39`, `30–39` y `30 a 39 años` representan el mismo grupo. Códigos explícitos como `U18` se normalizan. No se asigna un grupo desde la edad numérica ni desde un nombre de categoría.
- Si falta sexo/grupo etario, o el sexo es no informado, no hay categoría ni puesto de categoría. La general sigue disponible cuando existen distancia y marcas válidas.
- El texto importado de `category` se conserva como antecedente. Cambiarlo no altera grupos ni puestos. No se genera al guardar ni determina filtros o podios.
- La general conserva distancia/sexo. La exclusión del top 3, incluidos empates, promueve a los siguientes elegibles antes de calcular puestos de categoría.
- La web, el PDF y el motor C# consumen la misma definición. El PDF usa los puestos oficiales y no genera una segunda clasificación de «categoría base».
- Cada distancia lleva `category_criteria = [sex, age_bracket]` y `category_policy_version = category_criteria_v1`. Esta versión permite solamente esa combinación. Un criterio futuro necesita campo, normalización y soporte en ambos motores; los valores desconocidos se rechazan.
- El intercambio D07 declara `category_criteria_v1@1`. Los clientes antiguos no pueden publicar con esa regla; una diferencia de resultados revierte la publicación completa. Los eventos offline antiguos requieren conversión revisada.

## Entorno

Supabase separado: `crono-criteria-synthetic`, API `http://127.0.0.1:55421`, Postgres 55422. Solo se copian esquema y código de funciones; las semillas están deshabilitadas. Las pruebas rechazan cualquier otra dirección. No hay operaciones remotas en los scripts.

Desde `web-cronometraje`, con Docker activo:

```powershell
./scripts/category-criteria-qa.ps1 Init
./scripts/category-criteria-qa.ps1 Build
# Otra terminal; mantenerla abierta durante las pruebas:
./scripts/category-criteria-qa.ps1 Start
# Con el servidor ya activo:
./scripts/category-criteria-qa.ps1 Test
./scripts/category-criteria-qa.ps1 Demo
```

La compilación de RFID Local se comprueba con:

```powershell
dotnet msbuild ../RFIDLocal/RFIDLocal.csproj /p:Configuration=Release /p:UseSharedCompilation=false /m:1 /nr:false /verbosity:minimal /nologo
```

La demo deja 32 corredores ficticios en 10KM y 5KM, varios grupos etarios, DNF con llegada y criterios incompletos. 10KM excluye la general; 5KM permite doble premiación. Acceso y enlaces en `local-backups/category-criteria-qa/acceso-demo.txt`; PDF descargado por la ruta real en `podios-sinteticos.pdf`. Nunca versionar esos archivos.

## Verificación

Las pruebas ejercitan formularios HTTP reales, RLS y propiedad, concurrencia, auditoría, edición de criterios, nombres históricos diferentes, grupos distintos, empates, DNF confirmado con llegada y reversión, PDF, clasificación pública y 5000 llegadas en un lote. El puente `RFIDLocal/tests/CriteriaBridge.csproj` compila el código real del motor offline y contrasta sus puestos/etiquetas con SQL. La publicación D07 comprueba compatibilidad y rollback ante una diferencia deliberada.

Las cuentas y eventos de cada ejecución se eliminan por sus UUID y se comprueba que los conteos iniciales se restauren. La demo persistente es independiente y no se elimina con esas pruebas. Reporte: `local-backups/operator-qa/report.json`.

Validación del 23 de noviembre de 2026: pasaron 15 pruebas de lógica y 20 escenarios de integración con el esquema final reinstalado desde cero, incluido el lote de 5000 llegadas y su PDF paginado. TypeScript, ESLint y las compilaciones web y RFID Local pasaron. El PDF de la demo se descargó desde la ruta autenticada y se revisaron visualmente sus cinco páginas. Las cuentas de la batería se eliminaron antes de crear la demo persistente.

Para detener la web usa Ctrl+C en su terminal; para detener la base sintética conservando datos:

```powershell
./scripts/category-criteria-qa.ps1 Stop
```

La migración de despliegue incluye una conversión única y auditada de grupos etarios literales inequívocos; el cálculo en ejecución nunca interpreta nombres. Se ensayó con 1681 participantes y se comprobó la reversión. Los eventos offline antiguos requieren terminar o liberar su preparación antes de cambiar de versión. Consulta `DEPLOY_CATEGORY_CRITERIA.md`.
