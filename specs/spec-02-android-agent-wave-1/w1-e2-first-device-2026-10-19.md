# W1-E2 — primer dispositivo: implementación local y evidencia

**Corte inicial:** 2026-10-19. **Rama:** `codex/spec-02-wave-1`. **Base inicial:** `6f95241b859deee58835c6a9fc44a747192f7fab`. La evidencia de este corte se obtuvo antes de la [preparación de publicación](w1-e2-staging-upgrade-readiness-2026-10-19.md). No se accedió al servidor, no se instaló una APK ni se utilizó GPS real. La PoC, Inventori, Billing y ManageEngine permanecieron fuera de alcance.

## Auditoría de brechas y resultado

| Componente | Situación al iniciar | Resultado local | Estado verificable |
| --- | --- | --- | --- |
| Identidad SPEC-01, invitación, claim, PoP, activación | Backend reutilizable; Web y Android desconectados | Web de registro, emisión/revocación y confirmación; cliente de inscripción y sesión Kotlin; inventario sintético enriquecido con auditoría | `VERIFIED_SYNTHETIC` en HTTP/PostgreSQL y JVM; físico `BLOCKED` |
| Políticas, asignaciones, sesiones y posiciones | Backend W1-B/E1 reutilizable; Web de solo lectura | Editor Web con CSRF, ETag e idempotencia; configuración y captura conectadas al agente empaquetado | `VERIFIED_SYNTHETIC` por componentes; flujo APK→servidor físico `BLOCKED` |
| Salud, historial y recorrido | Backend reutilizable; UI parcial | Salud observada, última comunicación, sesiones, posiciones y recorrido SVG relativo desde API autorizada | Lecturas HTTP sintéticas `VERIFIED_SYNTHETIC`; mapa geográfico y navegador E2E `BLOCKED` |
| APK | Núcleo JVM y adaptadores Android sin empaquetar | Módulo Android, Activity de inscripción, AndroidKeyStore, FGS visible y APK de prueba firmada | Build/firma `VERIFIED_SYNTHETIC`; ejecución Android `BLOCKED` |
| Tenant/MDM real | Sin aprobación operativa | Registro Web restringido explícitamente a binding `fake`/tenant `synthetic` | Asociación con empresa real y requisitos MDM `BLOCKED` |

## Implementación

- **Corte A:** `EnrollmentPanel` crea borrador, emite invitación de un uso con QR y valores manuales, revoca invitación, muestra estado, fecha de inscripción y última comunicación. El backend agrega `GET /v1/admin/enrollment/devices` y `DELETE /v1/admin/devices/:device_id/invitations/:invitation_id`; las rutas existentes de creación, invitación, evidencia, activación e instalación quedan conectadas. No se alteró la respuesta aprobada de `GET /v1/admin/devices`.
- **Corte B:** `apps/android-app` empaqueta el agente Kotlin. La Activity visible reclama/probará el claim con clave P-256 de AndroidKeyStore, muestra el código de emparejamiento, obtiene sesión corta por challenge y permite iniciar el FGS desde una acción visible. El estado local usa AES-GCM con clave AndroidKeyStore y conserva la cola sin ACK hasta confirmación. Entrada manual del código disponible; el QR mostrado por Web aún no tiene lector en la APK.
- **Corte C:** Web crea/edita borradores, define días, horarios, zona IANA e intervalos, asigna dispositivos y publica/pausa/revoca según capacidad. El agente usa configuración PoP `/v1/device/*`, ventana UTC y motor de sesiones existente. No se promete arranque automático tras reinicio o batería agotada: no hay `BOOT_COMPLETED`, y el servicio usa `START_NOT_STICKY`.
- **Corte D:** vistas operativas de GEOPS Web leen endpoints autenticados para dispositivos, sesiones, posiciones y salud; distinguen observado/inferido/desconocido y posible batería agotada como hipótesis. El recorrido es un gráfico SVG relativo sin cartografía ni tiles. Los fixtures quedan en pruebas y demo explícita.
- **Corte E:** la prueba HTTP en base desechable cubre inscripción, política, configuración PoP, sesiones, posiciones PostGIS, salud y lectura Web en suites independientes. No existe una ejecución única APK→PostGIS→navegador ni prueba de un teléfono real.

## Evidencia local

| Verificación | Resultado |
| --- | --- |
| OpenAPI SPEC-01/SPEC-02, typecheck API/Web, build API/Web, lint | PASS; lint conserva 12 advertencias previas de non-null assertion |
| Node/Web/contratos/restore en `npm run test` | PASS: 18 MDM, 12 API, 2 cookies, 12 Web, 5 contratos, 2 migración destino, 1 restore |
| PostgreSQL/PostGIS desechable `geops_verify_20261019` | 14 migraciones aplicadas; inscripción PASS; política 45, configuración 24, sesiones/posiciones 69, salud 37, operaciones/Web 40 aserciones PASS |
| Kotlin/JVM `syntheticTest` | 17 casos PASS, incluidos inscripción, PoP, ventana, buffer/ACK, reinicio, revocación simulada |
| Android `assembleRelease` | PASS, paquete `com.geops.mobile`, minSdk 26, targetSdk 35; `apksigner verify` PASS firma v2 |
| Escaneo local de secretos | PASS para 326 archivos elegibles; el escáner no sustituye una revisión manual de seguridad |

**APK local:** `apps/android-app/build/outputs/apk/release/GeopsAndroid-release.apk`. **SHA-256 APK:** `7CF8A4A24C2220781395F80F8526AD4AE8D884F1CBA3E4FCF7993B8326ED08DA`. **SHA-256 certificado de firma:** `bf7eea177e6ec560b1178753f0b52f9e2b3468abe004b25ef81ef578ff78b3f1`. Es una identidad de firma **de prueba**, con keystore local ignorado por Git. [Procedimiento de conservación](../../apps/android-app/README.md).

## Seguridad y límites de la demostración

- Las mutaciones administrativas conservan sesión, CSRF, Origin, capacidad y auditoría del backend. La UI oculta acciones sin permiso, pero el servidor sigue siendo la autoridad. PoP firma rutas canónicas y nonces; el cliente rechaza redirecciones y origen de invitación ajeno.
- El registro actual crea únicamente un binding sintético `fake`/`synthetic`. La excepción de atestación no verificada requiere acción explícita del administrador y solo aporta evidencia sintética; **no** confirma MDM ni una empresa real. Concesiones de tenant y revisión de privacidad operativa requieren aprobación independiente.
- No hay evidencia de instalación, permisos, proveedor GPS, arranque/reinicio, recuperación offline, consumo de batería, restricciones OEM ni visualización desde navegador contra Staging vivo. No declarar `VERIFIED_PHYSICAL` ni W1-E2 cerrada.
- No se añadió migración 0015. Si Staging ya ejecuta el esquema 0001–0014 del commit `6f95241`, necesita actualizar las imágenes API/Web y validar el contrato nuevo, **sin ejecutar migraciones ni reiniciar el gate**. La APK firmada requiere una distribución separada y aprobada. Este trabajo no modifica su servidor ni su base.
- La prueba `gps-operations.integration.mjs` usa cliente Web sobre `app.inject` y datos sintéticos, no un navegador completo; la prueba de enrolamiento HTTP y las suites GPS son independientes. Falta un E2E autenticado único desde la UI hasta un agente en Android.

## Gate para ensayo físico autorizado

1. Revisar de forma independiente identidad, almacenamiento cifrado, atestación de prueba, permisos, retención, avisos y logs; cerrar gates SPEC-00/01 y ADR-018 sin cambiar los requisitos MDM por omisión.
2. Preservar la identidad de firma de prueba en custodia segura y verificar que el APK entregado tenga el hash anterior. Preparar instalación supervisada en un dispositivo corporativo autorizado y registrar OS/OEM/versión, permisos y políticas Android Enterprise existentes.
3. Comprobar que Staging conserva las 14 migraciones y sus checksums, respaldar sus volúmenes, y actualizar API/Web mediante una ventana aprobada sin migrar ni cambiar el gate/epoch. Verificar HTTPS, cookies, CSRF, PoP, auditoría y aislamiento de tenant. Esta entrega no realiza esas acciones.
4. Con consentimiento/aviso aplicable, crear invitación Web, reclamar desde la APK, comparar código físico, confirmar/activar, asignar política de ventana corta y comprobar inicio efectivo, ubicación real, ACK PostGIS, salud y lectura Web. Probar 401/403, revocación, fuera de horario, batería baja, pérdida de red y reinicio sin inferir un inicio efectivo.
5. Conservar capturas/logs sanitizados, identificadores de eventos y consultas auditadas como evidencia; declarar resultado físico solo con ese registro y sin publicar coordenadas privadas.

**Decisión:** implementación local considerable y suites sintéticas aprobadas; **W1-E2 sigue `BLOCKED` para éxito completo y uso operativo**. Los requisitos MDM-001 a MDM-006 originales conservan su estado y no se modifican por esta entrega.
