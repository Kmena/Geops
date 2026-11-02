# GPS corporativo y BYOD: estado operativo de B32

Fecha: 2026-11-02. SPEC-04 V1 está desplegada solo en staging desde el commit de aplicación `00dbb254d574e64e06fa17e6a3e5b3bc9430fb27`. Producción no se modificó.

## Resultado de staging SPEC-04

| Indicador | Estado verificado |
| --- | --- |
| `LEGACY_DEVICE_STATUS` | UUID `a5fff5f2-5746-495e-9e6b-e7687104c5ad`, etiqueta `Android_prueba_Poco`: `DECOMMISSIONED`; una transición `device.decommission` auditada. |
| `GPS_AUTHORIZATION_STATUS` | Revocada del lado servidor. El control posterior encontró cero claves, sesiones, instalaciones, autorizaciones continuas, asignaciones efectivas, autorizaciones de seguimiento y vínculos de agente activos. |
| `OFFLINE_REVOCATION_STATUS` | `offline_pending=0`, `offline_not_after=null`: ninguna entrega registrada conserva autorización offline vigente. El propietario confirmó además que el equipo está detenido y no se usará. |
| `ACTIVE_DEVICE_INVENTORY` | El UUID retirado queda excluido por estado del inventario GPS activo y permanece en el historial administrativo. |
| `SPEC04_STAGING_STATUS` | Despliegue simple exitoso: API/Web/PostGIS saludables, gate abierto, 35 migraciones y catálogo SHA-256 `58cc3e64c07fbbd7420c68133b965ac33a5af6e1a279d847040b3285052603b2`. Respaldo verificado `geops-stage-20261102T172231Z.dump`. |

El retiro preservó 486 posiciones, 18 eventos de sesión, 6 sesiones y 774 entregas de configuración; las cantidades antes y después coincidieron. No hubo reclasificación automática a MDM o BYOD. El bloqueo de compatibilidad del dispositivo heredado queda retirado tras esta verificación; la activación corporativa real sigue condicionada al mapeo de tenant, autorización individual y MDM verificado.

## Avance V1 y gate de despliegue

- El enlace de inventario MDM ya no activa la política continua. La mutación individual `PUT /v1/admin/gps-devices/:id/tracking-authorization` exige `If-Match`, permiso administrativo, base, evidencia, aviso de privacidad y vigencia. No existe activación masiva.
- La configuración v2 solo entrega captura activa cuando la propiedad y la política GPS concuerdan. `UNVERIFIED` recibe configuración inactiva. BYOD utiliza la revisión GPS de jornada; las rutas siguen siendo independientes. Android valida los campos nuevos del contrato y mantiene la versión de asignación monotónica en almacenamiento local.
- **Bloqueo corporativo:** el alcance administrativo vigente usa el tenant operativo `synthetic`; ManageEngine usa un identificador de cliente distinto. La revisión automática rechazó quitar la comprobación de tenant y el filtro de cliente del endpoint, porque podría permitir autorizar seguimiento en otra empresa. Se requiere un mapeo explícito y probado antes de activar un Huawei real. El retiro heredado no elimina este control.
- La base descartable aplicó 34 migraciones. Pasaron `gps-operations` (67 aserciones), `gps-config` (25), `gps-events` (70), `mdm-inventory`, `mdm-managed-enrollment`, 54 pruebas Web, `typecheck` completo, contratos, compilación `assembleDebug` y pruebas `test syntheticTest` del motor Android. Playwright abrió la Web local con respuestas API sintéticas y verificó que los campos BYOD aparecen al elegir la modalidad. No hay validación de navegador contra backend real ni prueba física. APK de depuración local: `apps/android-app/build/outputs/apk/debug/GeopsAndroid-debug.apk`, SHA-256 `5AE60470E20ABAC38461A9A0003DADEFA9843128B3DBCC40B68450A654E9B231`.

### Ensayo físico preparado

| Equipo | Preparación | Observaciones a registrar |
| --- | --- | --- |
| Huawei P40 corporativo | Enlazar inventario; comprobar que no captura por solo enlace; resolver gate de tenant; autorizar individualmente con aviso documentado | Intervalos entre fixes frente a 60 s, reboot, modo avión, retorno de red, ACK, estado FGS, indicador GPS, aviso y permisos visibles, gaps y batería |
| POCO BYOD | Autorizar individualmente; asignar revisión GPS de jornada en Políticas GPS; comprobar captura dentro y cierre fuera de jornada | Inicio y detención, permisos/revocación, posiciones con/sin ruta, cola offline y subida posterior, notificación y controles visibles |

No instalar la APK en los equipos hasta completar el gate corporativo y registrar la versión exacta compilada para el ensayo.

## Qué existe hoy

- Staging responde a `geops check staging` y `geops status staging` con gate abierto, API/Web/PostGIS saludables y 35 migraciones. Último commit de aplicación desplegado: `00dbb254d574e64e06fa17e6a3e5b3bc9430fb27` (2026-11-02 UTC).
- APK v9 candidata: política GPS v2 local, cola cifrada y subida independiente, arranque/reintentos según permisos Android, y política MDM continua de 60 s solicitados. No hay prueba física de 24/7 garantizado.
- B32 conserva evaluación de diez minutos acumulados, geozonas históricas, cobertura, evidencia insuficiente, reevaluaciones y scheduler. Revisión 3 sigue `TECHNICAL_ONLY`.
- La migración aditiva 0034 de propiedad y autorización individual está aplicada en staging, sin backfill ni activación automática. La API de lectura presenta `UNVERIFIED` si falta clasificación. Las ubicaciones se clasifican `EN_RUTA` o `FUERA_DE_RUTA` por hora de captura y vínculo histórico, sin alterar ingesta ni ACK.
- La revisión automática rechazó una migración propuesta que clasificaba y habilitaba automáticamente equipos corporativos existentes para seguimiento continuo. Esa activación no se incorporó; requiere aprobación explícita del propietario antes de retomarse.

## SPEC-04: retiro del dispositivo heredado

- El propietario decidió retirar el único dispositivo existente. La transición nueva `POST /v1/admin/devices/:device_id/decommission` exige el UUID real, motivo y acceso administrativo al tenant. No selecciona por cantidad ni toca otros dispositivos. La migración 0035 agrega `DECOMMISSIONED` sin modificar filas existentes.
- La transición registra auditoría, revoca clave, sesión, vínculo MDM operativo y autorización GPS; cierra instalación, asignaciones efectivas y vínculos de agente activos. Conserva propiedad histórica sin reclasificar, entregas de configuración, posiciones, sesiones, visitas y auditoría. Las reglas de base impiden nuevas concesiones GPS o vínculos de agente al dispositivo retirado.
- La respuesta indica `offline_pending` y `offline_not_after` para entregas aún posiblemente vigentes. Hasta comprobar revocación efectiva en el teléfono o alcanzar el último vencimiento, reportar **retiro del lado servidor con revocación offline pendiente**. No declarar desactivación completa.
- El UUID real y el estado offline se verificaron con la transición del API desplegado. El operador simple se usó para publicar V1 en staging y no se tocó producción.

## Procedimiento de diagnóstico

1. En **Dispositivos**, consultar propiedad, MDM, captura observada, última ubicación, último ACK y continuidad. `UNKNOWN`/`UNVERIFIED` requieren revisión; no significan ausencia de GPS.
2. Revisar política GPS, vigencia y jornada del equipo. La jornada BYOD es la revisión GPS; la ventana de ruta solo sirve para visitas.
3. Abrir posiciones con motivo de acceso. `FUERA_DE_RUTA` conserva la posición y no equivale a estar fuera de la geozona de visita.
4. Si Android dejó de entregar callbacks, revisar permiso preciso y de fondo, GPS, notificación de servicio, ahorro de batería, force-stop, reboot y diagnóstico local. No inventar fixes faltantes.
5. Si la cola tiene pendientes, consultar último ACK. No borrar datos cifrados ni reinstalar la APK para resolver un retraso de red.
6. Si MDM está temporalmente inaccesible, consultar último estado verificado y su vigencia; solo una revocación confirmada o expiración debe cerrar autorización futura.

## Validación antes de flota

- Completar contrato versionado de propiedad/autorización y migración aprobada. Clasificar BYOD solo con base documentada; verificar corporativo contra MDM del servidor. La clasificación de inventario 0034, por sí sola, **no autoriza ni detiene captura**.
- Pruebas de POCO y Huawei: Android 15/16, reinicio, pantalla apagada, ahorro de batería, modo avión, recuperación de red, permisos revocados, MDM offline/revocado. Registrar intervalos entre fixes frente al objetivo de 60 s, gaps, estado FGS, batería y entrega tardía.
- Validar privacidad y protección de datos en Costa Rica con asesoría competente antes de activar 24/7 en flota: finalidad, base, información al titular, proporcionalidad, retención y acceso.
- Mantener regresión GPS v2/v3, clasificación de rutas, visitas B32, Web y navegador para cambios posteriores. El manifiesto `spec04-release.json` incluye 0034–0035 y el operador creó respaldo antes de aplicarlas.
- Desplegar solo con el wrapper simple: `geops check staging`, `geops deploy staging -Manifest <manifest-nuevo>`, `geops status staging`. No usar controladores B31/B32 para cambios ordinarios. No producción ni distribución automática de APK.

## Evidencia local de esta iteración

- `npm run typecheck`: pasó.
- `npm run contracts:check`: pasó.
- `npm run test --workspace @geops/web`: 53/53 pasó.
- Base PostGIS descartable: 34 migraciones aplicadas; `gps-operations.integration.mjs` 67 aserciones, `gps-config.integration.mjs` 25 y `gps-events.integration.mjs` 70 pasaron. La base descartable fue retirada.
- `assembleDebug` de Android v9 pasó en contenedor SDK local (35 tareas, 2 min 53 s). La APK de depuración quedó solo en el checkout; no se instaló ni distribuyó. Sin prueba física POCO/Huawei.
- Staging se desplegó mediante `geops.ps1 deploy staging -Manifest scripts/deploy/simple/spec04-release.json`. El primer intento falló antes de migrar porque una sesión `psql` interactiva impedía aislar la base; el operador restauró las imágenes anteriores. Tras cerrar esa sesión, el segundo intento hizo respaldo, aplicó 0034–0035, reabrió el gate y dejó API/Web saludables. Producción no se modificó.
- SPEC-04 retiro: base descartable con 35 migraciones, checksum y replay pasó; integración de ciclo de vida pasó con transición auditada, tenant ajeno intacto, historial administrativo y clasificación `UNVERIFIED` preservada; `gps-operations.integration.mjs` pasó con 72 aserciones, incluida entrega offline pendiente y ocultación del inventario activo. `gps-config` (25), `gps-events` (70), contratos y typecheck API/Web pasaron. El contenedor y las bases descartables fueron retirados.

Diseño, matriz de migración y riesgos: [SDD](../../specs/spec-04-gps-device-model/SDD.md) y [ADR-026](../../specs/architecture/adr/ADR-026-propiedad-dispositivo-y-rutas-gps.md).
