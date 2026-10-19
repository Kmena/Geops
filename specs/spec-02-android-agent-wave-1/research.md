# Auditoría de la PoC y de Android

## Evidencia agregada del fin de semana

El usuario proporcionó **543 posiciones reales, 4 sesiones inferidas, 81.82% de intervalos dentro de 60 ± 15 s, 84 sincronizaciones tardías y 0 saltos GPS sospechosos**. Son agregados de referencia; esta auditoría no consultó el servidor ni incorporó coordenadas o identificadores personales. Una pausa entre puntos no acredita inicio, detención, pérdida de permiso ni ausencia de movimiento. Las cuatro sesiones son *inferidas*, nunca sesiones efectivas verificadas. El 81.82% describe intervalos evaluados, no cobertura de ventanas programadas; las 84 tardías requieren umbral y denominador congelados antes de compararse con pilotos.

## Componentes evaluados

| Componente PoC | Reutilización conceptual | Deuda antes de producto |
| --- | --- | --- |
| `android/.../TrackingService.kt` | Fused Location Provider, servicio `location` visible, callback y controles básicos de permisos. | Inicio manual, intervalos fijos, métricas en preferencias, sin política/versiones ni corte temporal en callback; no persistencia de sesiones. Reescribir como motor de política con estados y pruebas Android por versión. |
| `android/.../Buffer.kt` | Cola Room con IDs estables, pendiente/ACK. | `exportSchema=false`, sin cuota ni cuarentena, sin vínculo de sesión/política; revisar cifrado/gestión de llave y Auto Backup según ADR-008. |
| `android/.../SyncWorker.kt` | Lotes limitados, backoff de red, ACK validado y reintento. | Usa token PoC y endpoint experimental; debe usar PoP/rotación de SPEC-00, contrato v1, revocación y diagnóstico. |
| `api/schema.sql`, `store.mjs`, `validation.mjs` | `geography(Point,4326)`, `(device_id,event_id)`, `captured_at`/`received_at`, límites e idempotencia. | Tablas `poc_*` y bearer PoC aislados; sin `session_id`, versión de política ni particiones/retención de producto. Diseñar migración nueva; no copiar tablas. |
| `analysis/` | Consultas de solo lectura, pruebas sintéticas y métricas de latencia/cadencia. | Las sesiones se infieren por huecos; agregar telemetría de inicio/fin y causas. Los scripts no son servicio del producto. |

## Restricciones verificadas en documentación oficial

- [Android 12+ restringe el inicio de foreground services desde segundo plano](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start); hay excepciones específicas, no garantía general por horario. En Android 14+ crear un servicio que depende de permiso “while in use” desde fondo puede lanzar `SecurityException`; `ACCESS_BACKGROUND_LOCATION` resuelve acceso a ubicación en ciertos casos, pero no convierte todo inicio en permitido.
- [Android 14 exige tipo y permiso de foreground service `location`](https://developer.android.com/develop/background-work/services/fgs/service-types), además de ubicación habilitada y permiso coarse/fine. Declarar tipo, comprobar prerequisitos y conservar notificación visible. [Guía de lanzamiento](https://developer.android.com/develop/background-work/services/fgs/launch).
- [Android 15 limita el lanzamiento de varios tipos de servicio desde `BOOT_COMPLETED`](https://developer.android.com/about/versions/15/behavior-changes-15), en particular `dataSync`; no basar sincronización en un FGS `dataSync` iniciado al arrancar. La lista oficial no incluye `location` en esa restricción concreta, pero siguen las reglas generales de inicio y permisos.
- [Alarmas exactas son acceso especial y de uso limitado](https://developer.android.com/develop/background-work/services/alarms). WorkManager periódico tiene mínimo de 15 minutos; no sirve para garantizar GPS cada 60 s ni un inicio exacto. Se probarán ventanas con alarmas inexactas/recordatorios e interacción visible, sin pedir excepciones como sustituto de evidencia física.
- [Ubicación en segundo plano tiene límites y requisitos de permiso/visibilidad](https://developer.android.com/develop/sensors-and-location/location/background). Probar Android 10/12/14/15 y versiones actuales de modelos piloto, pantalla apagada, Doze, ahorro de batería, reinicio, denegación y permiso revocado.

## Investigación de diferencias entre sesiones

Registrar por ventana: hora programada UTC, inicio intentado/efectivo, motivo de inicio fallido, fin solicitado/efectivo, interrupciones, política/versión, app/OS/modelo, estado de permisos/GPS, batería, conectividad, backlog y eventos capturados/ACK. Métricas: cobertura efectiva = duración efectiva / programada; cadencia = intervalos 45–75 s / intervalos elegibles dentro de una sesión efectiva; latencia `received_at-captured_at` p50/p95 y umbral tardío explícito; tiempo offline; muestras rechazadas por horario/calidad; tasa ACK y duplicados. No medir huecos entre sesiones como intervalos de captura ni persistir identificadores personales en reportes de ingeniería.
