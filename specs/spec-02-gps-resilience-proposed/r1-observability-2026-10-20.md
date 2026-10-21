# R1 — Observabilidad Android (20/10/2026)

**Resultado:** **CONDITIONAL_PASS de observabilidad**, no PASS de continuidad operativa. Solo Android agent/app en `codex/gps-resilience`; ningún endpoint, OpenAPI, Web, base de datos, gate, teléfono ni MDM modificado. La autorización de captura conserva su predicado previo. R2 no se inicia en esta entrega.

## Baseline y dependencias

El checkout principal avanzó de `c27f656` a `e3f086e` con cambios confirmados de Web/infraestructura. Conserva cambios Android sin confirmar, incluidos archivos que R1 modifica. R1 parte de `c27f656` en su worktree aislado; no se trasladaron esos cambios en bloque. La instrumentación propia se integra sobre las interfaces actuales y usa parámetros opcionales para no romper consumidores existentes. La futura integración debe comparar por diff los diagnósticos locales del checkout principal con los cambios de R1 antes de escoger commits; no aplicar `ours/theirs` ni copiar el frontend.

**Archivos de código:** `apps/android-agent/src/main/kotlin/com/geops/agent/Diagnostics.kt` (nuevo), `PolicyEngine.kt`, `TrackingController.kt`, `BatchSync.kt`, `apps/android-agent/src/android/kotlin/com/geops/agent/GeopsLocationService.kt`, `apps/android-agent/src/test/kotlin/com/geops/agent/SyntheticTests.kt`, `apps/android-app/src/main/kotlin/com/geops/mobile/AgentRuntime.kt` y `EnrollmentActivity.kt`. No hay migración ni cambio de contratos. HEAD permanece `c27f656c71a82eee31e2bf281bb98eaf473be067`; cambios sin confirmar, sin commit/push/merge.

## Diagnósticos añadidos

| Fuente | Evidencia local registrada | Límite |
| --- | --- | --- |
| `GeopsLocationService` | `FGS_START_COMMAND`, promoción/fallo, registro/desregistro de listener y destrucción. Transiciones tempranas se retienen en memoria hasta que se adjunta el almacén cifrado. | No hay restart/FGS nuevo ni modificación de `START_NOT_STICKY`. Una muerte antes de adjuntar la clave puede perder la transición temprana. |
| `PolicyEngine`/`TrackingController` | Evaluación con motivo cerrado; política recibida/fallida, entrada/salida de ventana, versión y límites UTC, sin ID de política ni de dispositivo. | La autorización subyacente no se modifica. Fin normal exacto `WINDOW_ENDED` se distingue de vencimiento anticipado `OFFLINE_EXPIRED` y `OUTSIDE_WINDOW`. |
| Callback GPS | Hora original del fix y hora de recepción tomada en el callback de Android antes de entrar al ejecutor; aceptada/rechazada, razones temporales diferenciadas, inserción en cola solo tras persistencia. | Nunca guarda latitud, longitud, precisión, payload, boot ID o ancla en el journal. Una falla de cola se registra como `BUFFER_UNAVAILABLE` si el journal aún admite escritura. |
| `BatchSync` | Intento por tipo/conteo, ACK tras remover cola, backoff, 202, error de red, respuesta inválida, 401/403, 409/422 y cuarentena. | No guarda cuerpo HTTP, tokens, IDs de eventos ni coordenadas; el ACK conserva su validación actual. |

`EncryptedDiagnosticJournal` usa AES-GCM con IV generado por el proveedor, AAD propio, archivo independiente por instalación en `noBackupFilesDir` privado, reemplazo atómico, permiso propietario cuando POSIX está disponible, máximo 256 eventos/128 KiB y retención de 24 horas. El acceso concurrente de instancias del journal en el mismo proceso se serializa por ruta. Al leer o escribir se purgan físicamente entradas vencidas; si la app permanece sin ejecutarse, el archivo cifrado no puede purgarse hasta la próxima ejecución. Si el journal falla o está corrupto, la lectura del diagnóstico falla cerrada y `recordSafely` evita cambiar captura/ACK. El botón local «Ver diagnóstico técnico» resume callbacks, aceptadas, rechazadas, pendientes, cuarentena, últimas horas y motivos sin mostrar datos de ubicación. Los conteos de eventos son **solo de las 24 horas retenidas**; pendientes/cuarentena proceden de la cola cifrada. No se exporta ni transmite el journal.

## Caracterización ADR-017

La prueba sintética demuestra continuidad dentro de la instancia validada, detención al fin `[inicio,fin)`, rechazo tras `offline_not_after` y aplicación de una revisión más restrictiva recibida. También **confirma D13/C10**: un snapshot recibido antes de una instancia futura puede autorizarla offline cuando el reloj entra en ella y el TTL aún no vence. Se reproduce además al cruzar la medianoche hacia una nueva jornada dentro del TTL. ADR-017 exige contacto online antes de una instancia nueva. R1 solo registra el hallazgo; no altera `PolicyEngine.current()` para no introducir un cambio de autorización fuera de alcance.

**Propuesta para wave posterior:** persistir de forma protegida la instancia que estaba vigente durante la verificación online y exigir coincidencia al evaluar offline; una instancia futura requiere revalidación online antes de abrir listener. Probar actualización que reduce/amplía, reloj monotónico, boot, respuesta fuera de orden y callback concurrente. El arreglo no debe iniciar diariamente un FGS de manera desatendida ni solicitar `ACCESS_BACKGROUND_LOCATION`.

## Pruebas y límites

| Comprobación | Resultado | Alcance real |
| --- | --- | --- |
| `gradle syntheticTest --offline` en `gradle:8.14-jdk17` | **PASS: 26 casos**, incluidos 4 nuevos R1/ADR-017. | JVM sintética: cifrado/tamper/retención, concurrencia entre dos instancias, archivo por instalación, callback con recepción previa al ejecutor, rechazos temporales, cola, ACK/cuarentena, ventanas y reducción. No prueba AndroidKeyStore ni FGS real. |
| `gradle assembleDebug --offline` en `geops-android-build:local` | **PASS**, 35 tareas. | Compilación APK debug; no instalación, firma release ni teléfono. |
| `npm run contracts:check` | **PASS** | OpenAPI SPEC-01/02 actual, sin ruta ni esquema nuevo. |
| `npm run security:scan` | **PASS**, 384 archivos elegibles | Escaneo local; no reemplaza revisión independiente. |
| `git diff --check` y búsqueda de espacios finales del SPEC/journal | **PASS** | Incluye control de formato; el diff Git no incluye archivos nuevos hasta agregarlos al índice. |

La primera prueba Gradle sin red falló porque el worktree no tenía cacheado el plugin Kotlin. Se obtuvieron dependencias públicas en un contenedor temporal; la ejecución final Kotlin y la compilación Android se completaron **sin red** usando solo el worktree aislado. No hay prueba física de callbacks, FGS, Doze, OEM, AndroidKeyStore ni recuperación después de matar el proceso. No declarar continuidad operativa PASS por resultados JVM.

**Gate R2:** revisar esta evidencia, resolver la integración Git con los cambios Android locales, decidir la corrección D13 como cambio explícito de autorización y ejecutar sus regresiones antes de continuidad de servicio ya iniciado. Mantener la aceptación backend histórica sin cambios hasta R-P18. El journal no captura transiciones de FGS ocurridas antes de obtener la clave si el proceso muere antes de adjuntarlo; no persistirlas en claro para rellenar ese hueco. La purga de 24 horas es al siguiente acceso/escritura, pues una app detenida no puede ejecutar limpieza. El costo de cifrar/fsync por evento y las restricciones OEM requieren medición física posterior.
