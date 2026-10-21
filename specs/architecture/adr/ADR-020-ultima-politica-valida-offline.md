# ADR-020 — Última política válida para jornadas GPS offline

**Fecha:** 2026-10-21. **Estado:** decisión arquitectónica aprobada por el propietario; **implementación y contrato HTTP pendientes**. Sustituye la autorización offline de [ADR-017](ADR-017-politicas-gps-temporales-offline.md), denominada **DEC-GPS-OFFLINE-001**. Conserva de ADR-017 la autoridad de GEOPS Web/backend para publicar, revisiones inmutables, exclusión de solapes, horario IANA, intervalos `[inicio,fin)`, vigencia explícita `valid_from/valid_until`, rechazo de rollback, privacidad horaria y ausencia de garantía de arranque por Android. No cambia horarios publicados ni el modelo de identidad de [ADR-012](ADR-012-identidad-dispositivo.md)/[ADR-013](ADR-013-restore-security-epoch.md).

## Decisión anterior y motivo del reemplazo

ADR-017 exigía ancla monotónica del mismo boot, `offline_not_after` como mínimo de vigencia, 12 horas y fin de la instancia actual; cada nueva jornada exigía contacto online. El backend entregaba instancias UTC para siete días, pero solo las de la instancia ya validada podían activar captura. Esa regla convertía una caída de red prolongada en interrupción del servicio aunque existiera una política semanal previamente obtenida. La decisión aprobada traslada la evaluación ordinaria de horarios a la APK y separa captura de comunicación.

## Decisión vigente

Arquitectura **APK-FIRST / OFFLINE-FIRST / MDM-INDEPENDENT**: GEOPS Android es el motor de captura, evaluación local, persistencia cifrada y posterior sincronización. El servidor crea y distribuye el contrato y confirma la ingesta; ManageEngine administra instalación/permisos/restricciones. Ninguno participa en cada fix ni constituye latido necesario para seguir capturando.

La APK conserva la **última política recibida y autenticada que haya superado validación**. Una pérdida de red no la invalida. Dentro de su vigencia explícita y horario aplicable puede continuar una jornada, iniciar jornadas posteriores offline y atravesar varios días sin nueva descarga. No se introduce un TTL de 12 horas, una caducidad al fin de la primera ventana ni un requisito de contacto por jornada. Un fallo de descarga conserva la política anterior; solo una nueva revisión/tombstone validado la reemplaza. Si no hay política válida, si `valid_until` ya pasó, si la identidad/clave local es inválida o si el horario no puede determinarse de forma segura, no se captura. La decisión no autoriza seguir indefinidamente después del `valid_until` explícito.

Al reconectar, la consulta de configuración y la subida de pendientes son procesos independientes y se solicitan con prontitud; **la espera o fallo de HTTP no bloquea capturas** bajo la última política válida. Al recibirse una revisión o revocación autenticada, se aplica antes de procesar el siguiente callback mediante una barrera de generación. Las posiciones ya persistidas conservan su política/versión y hora originales. Una revocación remota no observada **no puede detener** la captura offline; el intervalo de exposición pasa de un máximo anterior de 12 horas/instancia al tiempo restante de la política explícita, potencialmente varios días. Esto requiere aceptación expresa de privacidad/seguridad antes de captura real. No se inventan coordenadas para intervalos sin fix.

## Límite de seguridad y tiempo

La respuesta PoP/TLS autenticada y el almacén AEAD/Keystore actual son base para autenticar el origen de la política al recibirla y detectar modificación local; no equivalen a una firma de política transportable ni resuelven por sí solos restauración/rollback de almacenamiento. Se conserva `assignment_version` máximo durable, identidad de instalación y controles de [ADR-013](ADR-013-restore-security-epoch.md). Una política corrupta, ajena, de esquema desconocido, con versión inferior o no verificable se rechaza sin desplazar la última válida.

El ancla monotónica actual solo sirve durante un boot. Para una jornada offline tras **reinicio físico**, esta decisión permite usar la política persistida, pero exige diseñar y probar un mecanismo de tiempo local y de detección de manipulación/retroceso después del reboot. Sin reloj de red no existe prueba criptográfica general de hora civil correcta en un Android ordinario: el modelo de amenaza debe declarar ese riesgo. No se debe afirmar que el diseño anterior de ancla garantiza tiempo confiable entre boots. La captura se cierra si la hora es incoherente o no puede evaluarse; el criterio preciso y la evidencia de boot son delta técnico pendiente. El permiso de Android y una vía legal para arrancar FGS siguen siendo condiciones independientes; force-stop/parada explícita no tienen recuperación prometida.

## Compatibilidad y deltas obligatorios antes de implementación

El HTTP/API y el agente actuales **no cumplen aún esta decisión**:

| Contrato actual | Delta requerido, sin fijar aquí campos nuevos |
| --- | --- |
| `GET /v1/device/config` v1 entrega `policy` recurrente y `window_instances` UTC solo hasta siete días; `offline_not_after` se recorta a 12 h/primera ventana. | Versionar el contrato para que el cliente pueda probar localmente qué asignación, vigencia, excepciones y reglas IANA aplican a cada jornada offline; definir autoridad ante horizonte agotado, cambio DST/tzdb y asignación futura. Un horizonte fijo de siete días no satisface «varios días» sin límite explícito. |
| Android `PolicyEngine` exige `validatedInstance`, mismo `boot_id`, ancla y 12 h. | Sustituir únicamente esos gates offline por evaluación segura de la última política; conservar identidad, versión, ventana, precisión, sesión y rechazo de cambios no autenticados. |
| Ingesta valida `capture_anchor_id`, tiempo monotónico del mismo boot y diferencia de hasta 30 s; dependencia de sesión [ADR-016](ADR-016-identidad-sesiones-gps.md). | Versionar validación de eventos nacidos en jornadas/boots offline, preservar `event_id` y `client_session_id`, reconstruir autorización histórica y distinguir hora reportada de hora verificable. No declarar que el servidor v1 aceptará esos eventos. |
| Backend tolera llegada fuera de orden por siete días y retiene posiciones 90 días. | Decidir explícitamente aceptación/cuarentena de backlog posterior a siete días y pruebas de revocación tardía. No borrar pendientes sin ACK ni aumentar retención en silencio. |

No se crea endpoint, columna, migración ni nombre de estado nuevo por este ADR. El diseño de la extensión HTTP/versionado y la migración de política/cola pertenecen a Wave A/D y deben pasar revisión SDD/API/seguridad antes de código. Un cliente o servidor v1 conserva comportamiento anterior y **no** debe anunciar soporte DEC-GPS-OFFLINE-001.

## Pruebas y consecuencias

Vectores: política válida recurrente con excepción `OFF` y `REPLACE`; jornada nueva sin red; varias jornadas; cruce de medianoche y DST; `valid_until` exacto; actualización fallida; revisión menor; reinicio físico sin red y reloj alterado; revocación recibida al reconectar; backlog posterior a siete días; IDs/ACK; pantalla apagada y restricción Android. Cero posiciones fuera de la política local aplicable. Comparar versión del contrato declarada y realmente soportada en APK/backend. El piloto físico queda bloqueado hasta resolver tiempo entre boots, validación histórica del backend, horizonte de asignación y aceptación del riesgo de revocación diferida.
