# R3 — Sincronización independiente de la captura (20/10/2026)

**Estado:** `CONDITIONAL_PASS` sintético. No equivale a continuidad comprobada en teléfonos. HEAD base aislado `c27f656`; R1/R2 siguen sin commit junto con R3. No se tocó Web, API ni OpenAPI; no se hizo merge, push ni despliegue.

## Arquitectura

`TrackingController` persiste cada evento antes de avisar al planificador; el aviso es mejor esfuerzo y no invalida una captura ya almacenada. Si falla la programación, el journal cifra el motivo `SCHEDULING_FAILED`. `AgentRuntime` conserva únicamente el temporizador de política/ventana y deja de ejecutar `BatchSync`. `PendingUploadJobService` se ejecuta mediante **JobScheduler**, con condición de cualquier red, trabajo persistido tras reinicio y backoff exponencial. Se usa la API del sistema disponible desde el `minSdk 26`, sin nueva dependencia. El job inmediato respeta la frecuencia de sincronización de la política vigente como latencia mínima; el drenaje también comprueba ese mínimo para impedir que el barrido lo adelante. Un job periódico de 15 minutos cubre la carrera entre escritura cifrada y programación del inmediato. El worker solo abre estado/diagnóstico cifrado, AndroidKeyStore, sesión PoP y transporte HTTPS; no contiene `LocationManager`, `GeopsLocationService.runtime`, `TrackingController.tick` ni registro de listener.

`PendingUpload` drena en orden eventos de sesión, posiciones y salud, hasta 12 lotes por ejecución. `BatchSync` conserva los event IDs, batch IDs, validación completa de ACK y semántica previa: 202 no confirma, respuesta perdida repite de forma idempotente, 409/422 aíslan inválidos, 429/5xx/red reintentan, 401/403 bloquean nuevos envíos y detienen una captura que siga activa. Un 401/403 al abrir sesión PoP también se clasifica como rechazo de autorización. El bloqueo se conserva cifrado hasta un nuevo refresh de configuración autenticado desde el inicio manual. No se borra ningún evento sin ACK válido. Las escrituras del FGS y del job sobre `agent-state.bin` usan el mismo lock por ruta dentro del proceso; las lecturas y actualizaciones de handles separados se serializan. El estado cifrado v1 conserva compatibilidad con campos opcionales nuevos.

Un cambio de instalación con pendientes de la identidad anterior falla cerrado antes de sustituir el snapshot; esos eventos quedan para resolución supervisada, sin atribuirlos a la nueva identidad. Las capturas aceptadas conservan su `assignment_version`, sesión, ancla y timestamp originales. R3 **no modifica** la regla backend de aceptación histórica de GPS-OFFLINE-001.

## Escenarios y nivel de evidencia

| Escenario | Evidencia sintética | Falta comprobar físicamente |
| --- | --- | --- |
| Red perdida y recuperada durante el turno | Backoff, preservación de eventos y restricción de red del JobInfo. | Momento real de ejecución/ACK bajo Android/OEM. |
| Red recuperada fuera de horario; fin normal; FGS detenido | `PendingUpload` vacía varios lotes con reloj posterior al fin, sin instancia de runtime GPS; JobService no tiene ruta de captura. | Ejecución del job y ausencia de nuevas lecturas en dos teléfonos. |
| Proceso recreado o teléfono reiniciado | Job persistido y barrido periódico; el estado AES-GCM se reabre con handles independientes. | Restauración real por JobScheduler, AndroidKeyStore y restricciones de arranque del fabricante. |
| HTTP persistió pero se perdió respuesta | Mismo event ID en retry y ACK duplicado válido elimina una sola vez. | Ensayo E2E con proxy o backend sintético desechable. |
| 401/403; PoP rechazado | Bloqueo cifrado y cola intacta; sin nuevos posts hasta refresh autenticado. | Revocación de instalación en entorno autorizado. |
| 409/422; 429/5xx; cola vacía; múltiples lotes | Regresiones `BatchSync` y nuevos casos R3 de backoff, ACK, cuarentena y 205 eventos. | Latencia, consumo y cuotas bajo red real. |
| Cambio de política/identidad durante envío | Payload ya persistido conserva versión; nueva identidad con pendientes anteriores falla cerrado. | Carrera real FGS/job y decisión de recuperación supervisada. |

## Límites y riesgos

- JobScheduler ofrece ejecución **diferible**. Doze, standby, restricciones del fabricante, ahorro de batería y Force Stop pueden demorar o impedir el job. El barrido de 15 minutos tampoco es una garantía temporal. Un reinicio no inicia captura GPS; únicamente puede reanudar la subida pendiente.
- El lock protege handles dentro del mismo proceso de GEOPS; no se configura multiproceso. La doble entrega remota eventual depende de la idempotencia backend vigente. La parada por sistema durante una petición deja el evento pendiente si no se procesó ACK.
- Una re-inscripción con pendientes de instalación anterior requiere procedimiento supervisado; R3 preserva los datos y falla cerrado. Un borrado de datos de la app o pérdida de AndroidKeyStore deja la cola ilegible; no se debilita cifrado para recuperarla.
- La aceptación de revisiones históricas D12 y los permisos de lectura/alertas quedan para revisión separada. El worker no pide `ACCESS_BACKGROUND_LOCATION`, no inicia FGS de ubicación y no implementa inicio diario automático.
- Una prueba JVM o build Android no demuestra cuándo Android ejecuta el job ni que un fabricante permita red en background. No declarar PASS operativo antes de dos teléfonos y revisión de privacidad.

## Verificación local

| Comprobación | Resultado | Límite |
| --- | --- | --- |
| Kotlin/JVM `syntheticTest --offline` | **PASS: 39 casos** R1–R3, SPEC-01/02 y regresiones de cola/ACK. | No simula el planificador ni Doze del sistema. |
| Android `assembleDebug --offline` | **PASS**, 35 tareas. | Compilación, sin instalación física ni release firmada. |
| Contratos `npm run contracts:check` | **PASS**. | No se cambiaron esquemas compartidos. |
| Escaneo `npm run security:scan` | **PASS**, 389 archivos elegibles. | No sustituye revisión independiente. |
| `git diff --check` y búsqueda estática del worker | **PASS**; sin invocación a `LocationManager`/registro GPS desde la ruta de subida. | `diff --check` no cubre archivos nuevos aún sin seguimiento; la búsqueda estática no sustituye instrumentación física de accesos a ubicación. |

## Prueba física pendiente en dos Android

Usar dos equipos autorizados de fabricantes distintos, sin subir coordenadas, códigos ni tokens al repositorio. Registrar versión Android, estado de batería, permisos, inicio/fin de ventana y marcas de captura original, persistencia, intento, ACK y razón de rechazo. Para cada equipo: iniciar manualmente dentro de una ventana breve; cortar red durante capturas; comprobar cola cifrada y cero ACK; recuperar red primero dentro y luego después de la ventana; comprobar ACK de eventos antiguos y cero callback nuevo fuera de horario; detener FGS con pendientes; repetir tras muerte de proceso y reinicio; probar Force Stop como límite; inducir 429/5xx y respuesta perdida en un backend sintético. Separar retraso de captura de retraso de subida. No activar GPS real ni instalar desde este corte.

## Fuentes del mecanismo

- [JobInfo.Builder: red, persistencia, backoff y latencia](https://developer.android.com/reference/android/app/job/JobInfo.Builder).
- [JobService: trabajo asíncrono, parada y reintento](https://developer.android.com/reference/android/app/job/JobService).
- [Límites de energía, Doze y standby](https://developer.android.com/topic/performance/power/power-details).

**Gate R4:** reconciliar Android local por diff, pruebas físicas R3, aceptación histórica D12 y revisión de seguridad/privacidad. R4 no se inicia con esta entrega.
