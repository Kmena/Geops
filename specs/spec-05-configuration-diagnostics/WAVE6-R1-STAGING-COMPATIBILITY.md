# W6-R1 — Compatibilidad de staging y APK

Fuente observada: [inventario remoto](WAVE6-R1-STAGING-INVENTORY.md). Fuente candidata: rama aislada `codex/mdm-diagnostics-wave0`, código Waves 1–5 y ledger local 0001–0042. El SHA final de la candidata se fija en el manifiesto de release después de confirmar todos los archivos fuente; el SHA `b597c9f52f3f53da5e9d9be0fce43351f9eb4561` es el **base instalado**, no la candidata SPEC-05.

| Relación | Estado | Evidencia / gate |
| --- | --- | --- |
| SQL 0040 instalado → 0042 candidato | PASS de prefijo; despliegue BLOCKED | El hash de 0001–0040 calculado localmente es `40da2b60308dc0be781afb7aad45029a8b560ef76e979e8e5c178d2d85f8aeaf`, igual al controlador. 0041/0042 son nuevas; falta ledger fila por fila y restore real. |
| API instalada → APK Corporate Wave 4 | BLOCKED | GET de diagnóstico SPEC-05 404. La APK candidata necesita ese contrato. El contrato GPS v2 remoto no se probó por escritura no autorizada. |
| Web instalada → API instalada | PASS de rutas actuales; Wave 5 ausente | Ambas están healthy según controlador; `/v1/admin/auth/me` 401. Web Wave 5 y su endpoint no están instalados. |
| API candidata → DB 0042 | PASS laboratorio | Integraciones PostGIS Waves 1–5, 68 aserciones GPS/diagnóstico conjunto y migraciones 0035→0042; staging real aún no actualizado. |
| Web candidata → API candidata | PASS laboratorio | Chrome 20 checks con PostGIS y mock ManageEngine; requiere build `MDM_ENABLED=true`. |
| API candidata → APK previamente distribuida | PARTIAL | GPS v2/v3, auth técnica e identidad existentes se conservan en código y regresión; versión/configuración/cola de la APK *instalada* no verificadas. Ensayo con esa APK obligatorio. |
| APK Corporate Wave 4 → APK instalada | BLOCKED | Package, versionCode, firma y datos instalados no obtenidos de Moto G06 ni de inventario MDM real. Una APK de referencia versionCode 1 no acredita instalación. |
| ManageEngine real → API candidata | BLOCKED | Edición, licencia, región, scopes y conexión reales no verificados. `mdm_write_disabled` permanece. |
| Migración de vuelta a API/Web anteriores | BLOCKED como rollback automático | Una imagen 0040 no se presume compatible con esquema 0042. El plan exige gate cerrado y recuperación supervisada hacia adelante o restore validado; no hacer downgrade SQL automático. |

## Cambios concretos del release candidato

- API: recepción de snapshots diagnósticos PoP, reglas, historial, workspace MDM, comparación deseada/aplicada/efectiva, vista previa y solicitud de corrección con escritura operativa cerrada. Se conservan GPS v2/v3 y auth técnica.
- Web: `/status` extendido con dashboard, listado, detalle, permisos, diagnósticos, timeline y reportes; build con `MDM_ENABLED=true`.
- DB: `0041_device_diagnostics.sql` SHA-256 `078a74a6151b4aaca2dd937206636a7a230d0b89d22bb1520df00c7e8dcb0b22`; `0042_mdm_policy_workflow.sql` SHA-256 `d97a207432645007f97aefd2e57811bd2a418229b68d4da6745fe14c64581c1a`. Hash de lista 0001–0042: `1589cb3bf483e171b4e50aa0e33c06f71e504564b4a6e402eda4ecb4e5ac21a8`.
- Configuración: el Compose visible de staging tiene `MDM_ENABLED=false` en API/Web; la candidata Web de laboratorio se construye con `true`, pero habilitar conexión ManageEngine operativa requiere verificación/autoridad independiente. No cambiar secretos ni perfiles durante preparación.
- Android: no se generó nueva APK. La candidata debug Wave 4 es versionCode 4; no se instala en W6-R1.

## Decisión de promoción

La coincidencia de prefijo SQL permite preparar un upgrade **supervisado**; no basta para promover. Faltan imagen API/Web candidata con digest de registro, CI de SHA exacto, inventario runtime completo, respaldo/restore de staging, lectura MDM y compatibilidad de la APK instalada. La prueba local no sustituye prueba del host ni del Motorola.
