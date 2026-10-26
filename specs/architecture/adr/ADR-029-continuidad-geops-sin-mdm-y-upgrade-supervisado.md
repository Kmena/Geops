# ADR-029 — Continuidad GEOPS sin MDM y actualización supervisada

**Estado:** propuesto para el candidato local SPEC-03. **Fecha:** 2026-10-26.

## Contexto

La identidad GPS GEOPS sin binding se incorporó en 0028–0029, pero `gps_continuity_alert` de 0016 exigía `mdm_binding_id NOT NULL`. El monitor seleccionaba jornadas solo mediante `mdm_binding` activo, por lo que omitía dispositivos GEOPS sin MDM. El controlador desplegable v2 acepta perfiles hasta B23 y rechaza un ledger de 30 migraciones.

## Decisión

Se añade 0030 sin reescribir 0029. Para alertas sin binding, un trigger exige el propietario inmutable `geops_device_tenant`; la FK MDM sigue validando alertas con binding. Un índice `NULLS NOT DISTINCT` conserva una única alerta abierta por dispositivo, jornada e instalación. El monitor selecciona jornadas GEOPS solo con instalación activada sin binding y propietario de tenant; empareja evidencia por binding nullable usando `IS NOT DISTINCT FROM`. La lectura administrativa exige ambos permisos y concesiones del tenant. No cambia la captura, el protocolo GPS, ACK ni Android.

La actualización B23→B30 requiere detener API y Web y cerrar el gate antes de migrar. Tras B30, la API B23 no debe arrancar; la recuperación es hacia una aplicación B30 compatible. El supervisor de laboratorio modela esta regla y conserva un journal por fase, pero **no sustituye el controlador remoto v2 instalado**. Su empaquetado, firma, política y prueba de actualización real quedan pendientes; no se autoriza staging con este ADR.

## Consecuencias

- El prefijo B23 y las migraciones 0023–0029 conservan sus checksums.
- El esquema objetivo del candidato pasa a 0030 por autorización explícita del usuario.
- Los resultados de continuidad sin MDM son inferencias del servidor sujetas a la misma política de retención y calibración pendiente.
- Una transición de tenant o instalación cierra la alerta previa; no se reutiliza evidencia de otro tenant.
- No hay downgrade SQL automático ni rollback de API a B23 sobre B30.
