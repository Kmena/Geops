# Plan de pruebas y evidencia

**Estado:** plan general con resultados locales ejecutados para Waves 1, 2 y planificación de Wave 3; vínculo agente–dispositivo y Waves 4–5 pendientes. `U` unitaria pura; `I` integración con PostgreSQL/PostGIS desechable; `C` contrato API/GPS; `E` Web extremo a extremo; `R` resiliencia/carga; `F` dispositivo físico autorizado. Cada caso debe guardar fixture, versión de regla, resultado esperado/observado y evidencia de ejecución. Nunca etiquetar simulación como `F`.

**Actualización Wave 1:** la ejecución local sintética de catálogo cubrió FR-01–03, permisos, CSRF, idempotencia, ETag, PostGIS, radios, permanencia y revisiones con 57 comprobaciones aprobadas. `scripts/run-spec03-browser-e2e.ps1` ejecuta 15 aserciones Web reproducibles en Chrome a 1280 y 390 px sobre una base descartable nueva; también se verificó navegación Tab manualmente. Ver [wave1-closure.md](wave1-closure.md). Los casos G-01–04 relativos al futuro motor de evaluación, y toda prueba `F`, siguen pendientes; esta evidencia de catálogo no los sustituye.

**Actualización Wave 2:** `scripts/run-spec03-browser-e2e.ps1` ejecuta además `route-catalog.integration.mjs` (76 comprobaciones) y `route-catalog.e2e.js` (14 comprobaciones Chrome, 1280/390 px), después de 57 + 15 de Wave 1 en PostGIS descartable. Cubre creación, búsqueda, borrador, dos sedes del mismo cliente, herencia/override dwell, obligatoriedad, orden visual, publicación, sellado SQL, snapshots históricos, edición posterior, reutilización, desactivación, acceso/CSRF/tenant, cursor, ETag/idempotencia, referencias inactivas y errores Web. Ver [wave2-closure.md](wave2-closure.md). `A-02` sobre permutación GPS y `A-03` sobre recurrencia siguen pendientes de sus waves; Wave 2 solo confirma que `suggested_order` es dato visual y no crea lógica de cumplimiento.

**Actualización Wave 3:** el mismo runner agrega `visit-schedule.integration.mjs` (**70/70**) y `visit-schedule.e2e.js` (**20/20 Chrome**) tras Waves 1–2, siempre en PostGIS descartable. Cubre agente, rutas distintas por fecha en horarios separados, concurrencia, cancelación, snapshots, semana/mes, recurrencia, excepciones, reejecución, tenant, permisos, CSRF, ETag y DST. Ver [wave3-closure.md](wave3-closure.md). La prueba de vínculo agente–dispositivo queda pendiente por identidad MDM-free.

| ID | Escenario y aserción principal | Nivel |
| --- | --- | --- |
| G-01 | Centro dentro, exterior y límite exacto: comparación geodésica y `d+accuracy`; límite con incertidumbre se marca ambiguo. | U,I |
| G-02 | Precisión baja y oscilación cerca del borde: no sumar pares ambiguos; histéresis operativa no cambia acreditación. | U,F |
| G-03 | Cambio de radio: visita antigua usa revisión congelada; nueva asignación usa revisión nueva. | I,E |
| G-04 | Geozona desactivada: no se asigna a futuro; historia sigue consultable. | I,E |
| G-05 | Lat/lon inválidas, radio 0 o fuera de política: 422 sin escritura parcial. | C,I |
| D-01 | Una entrada continua con suficientes pares alcanza umbral; un punto aislado suma 0. | U,I,F |
| D-02 | Tres entradas 4+3+5 min estimadas ante mínimo 10: suma 12, `COMPLETED`; salidas no reinician saldo. | U,I |
| D-03 | Entrada/salida/reentrada y permanencia insuficiente: intervalos disjuntos, porcentaje correcto. | U,I,F |
| D-04 | Cruce de medianoche y jornada posterior: clip por asignación, sin transferir segundos. | U,I |
| D-05 | Fin exacto de jornada y muestra posterior: `[start,end)`, posterior acredita 0. | U,I |
| D-06 | Duplicados, desorden y empate temporal: resultado y hash iguales tras permutar/reintentar. | U,I,R |
| D-07 | Hueco largo, pérdida GPS y precisión insuficiente: crédito 0 en hueco y `UNVERIFIABLE` si cobertura baja. | U,I,F |
| D-08 | Cambio de geozona/ruta/regla durante jornada: snapshot y versión preservados; reemplazo autorizado explícito. | I |
| D-09 | DST: horas inexistentes/ambiguas rechazadas o resueltas por política; UTC y día local consistentes. | U,I |
| O-01 | Jornada completa offline y reconexión día siguiente: usar `captured_at`, no `received_at`; reevaluar y registrar historia. | I,R,F |
| O-02 | Lotes fuera de orden, ACK repetidos, reenvío: PK/digest y evaluación única. | C,I,R |
| O-03 | Reinicio Android: cola y sesión recuperadas según contrato vigente; ninguna afirmación física sin ensayo. | C,R,F |
| O-04 | Retraso de varios días dentro del plazo aceptado: corrección trazable; después de retención: `UNVERIFIABLE`/rechazo documentado. | I,R |
| O-05 | Reproceso tras evidencia tardía: resultado nuevo, historial append-only, ningún doble intervalo. | I,R |
| A-01 | Ruta multicliente y cliente compartido entre rutas: snapshots independientes. | I,E |
| A-02 | Orden libre: permutar secuencia GPS no penaliza; ruta termina al completar obligatorias. | U,I,E |
| A-03 | Reutilización semanal y edición de plantilla: ocurrencia deduplicada y asignación histórica inmutable. | I,E |
| A-04 | Cancelación futura y reasignación: autoridad, motivo, ETag, auditoría, intervalos de agente. | C,I,E |
| A-05 | Agente sin dispositivo, dispositivo reasignado, horarios superpuestos: bloqueo o estado no evaluable según regla; nunca atribución implícita. | I |
| RTE-01 | Alta, búsqueda, edición, activación/desactivación, cursor, duplicado de código, errores y auditoría de rutas. | C,I,E — Wave 2 PASS local |
| RTE-02 | Borrador con varias sedes, dwell heredado/sobrescrito, obligatorias/opcionales, orden visual, eliminación; rechazar sede/cliente/geozona inválidos y ruta sin obligatoria. | C,I,E — Wave 2 PASS local |
| RTE-03 | Publicar y recuperar revisiones exactas; proteger UPDATE/DELETE/INSERT tardío; edición posterior conserva snapshot de geozona y metadatos anteriores. | I,E — Wave 2 PASS local |
| RTE-04 | Sesión, capacidad, tenant, CSRF, ETag, idempotencia y visualización responsive de mapa con círculos. | C,I,E — Wave 2 PASS local |
| S-01 | Tenant ajeno, falta de capacidad, CSRF, motivo ausente y cursor manipulado: 403/404/422 según contrato, sin fuga. | C,I,E |
| S-02 | Idempotency-Key repetida, digest distinto y ETag obsoleto: 200/409/412/428 previstos. | C,I |
| NR-01 | Suites existentes de captura, persistencia local, GPS v2, política offline y horarios mantienen contrato. | C,I,F |
| NR-02 | Auth, MDM, migraciones/gate y controlador de despliegues mantienen sus pruebas propias; ningún cambio en sus archivos por SPEC-03. | C,I,R |
| P-01 | Web: mapa, círculo, tabla y formularios por teclado; fallback si teselas fallan. | E |
| L-01 | Carga 25 dispositivos × 12 h, lotes tardíos y reproceso: p95 y lag frente a objetivos NFR-05, sin frenar ACK. | R |

**Cobertura mínima propuesta:** 100 % de reglas críticas (clip horario, deduplicación, versionado, clasificación de incertidumbre, tenant/permiso) por casos U/I con aserciones de bordes; todos los estados con al menos una prueba de transición; cada endpoint con caso válido, inválido y autorización negativa; 100 % de requisitos FR trazados en `traceability.md`. No fijar porcentaje de líneas como sustituto; registrar cobertura de ramas y revisar huecos. Wave 4 necesita replay determinista de al menos 10 000 permutaciones sintéticas sin discrepancia y carga del escenario L-01 dentro de objetivos medidos; física F requiere protocolo, dispositivo, señal, hora y resultado observado firmados. Estos son criterios de entrada propuestos, no PASS.

**Gates de no regresión:** ejecutar `apps/api` test/contratos y tests GPS de integración con DB desechable; `apps/web` test/build; vector de contrato SPEC-02; pruebas Android existentes y campaña física cuando corresponda. El conjunto exacto se reconcilia con HEAD al implementar. No ejecutar contra staging ni producción como parte de este documento.

## Ejecución Wave 4A local

`apps/api/test/visit-dwell-engine.test.ts` cubre clasificación interior/exterior/borde, precisión, entradas acumuladas, huecos, muestra aislada, replay desordenado, jornada y medianoche, barreras de identidad/sesión/arranque/ancla, velocidad, unión física y parámetros. `apps/api/test/visit-evaluation.integration.mjs` corre después de fixtures Waves 1–3 en PostGIS `geops_verify_*`: migración/checksum, permisos, idempotencia HTTP, falta de identidad, vínculo temporal excluyente, posiciones tardías y fuera de orden, acumulación, historial inmutable, ausencia de coordenadas en evidencia y auditoría. El runner `scripts/run-spec03-browser-e2e.ps1` crea y destruye contenedor sin volumen, además de repetir Chrome 1280/390 px de Waves 1–3 y servicios GPS seleccionados.

Pendiente de pruebas físicas y de política: trazas reales contra umbrales calibrados, retención y purga de derivados, aceptación MDM-free, reinicios/offline en dispositivo, disparo automático desde ingesta, carga de 25 dispositivos y 10 000 permutaciones. Ninguna prueba sintética cierra estos puntos.
