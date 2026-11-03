# Plan de pruebas — SPEC-03

**Estado:** P01–P19 siguen como plan de validación integral; W1-A ejecutó los subconjuntos de catálogo, permisos, borradores, concurrencia y regresión descritos en [w1-a-evidence.md](w1-a-evidence.md). Esto no declara PASS integral de P08/P11/P17/P18/P19 ni de otras waves. La medición de solo lectura del KMZ en [decisions.md](decisions.md#d-05--cuotas-de-carga) no valida el parser futuro ni P16. Pruebas futuras con DB desechable, ficheros sintéticos y fixture KMZ autorizado. Nunca usar datos de cliente en logs de CI.

| ID | Nivel | Escenario y oráculo |
| --- | --- | --- |
| P01 | Parser/integración | KMZ válido con carpeta, punto, polígono y línea: conserva source_path, originales, orden y WGS84; cero cambios operativos. |
| P02 | Seguridad | ZIP corrupto, CRC falso, traversal, ruta absoluta, symlink, entradas cifradas, bomba de expansión, exceso de nodos/vértices: rechazo acotado, sin salida de sandbox ni basura temporal. |
| P03 | Seguridad/XML | DTD, entidad externa, NetworkLink, descripción con script, href remoto: no red ni ejecución; respuesta saneada. |
| P04 | API/DB | Upload repetido con misma clave y hash devuelve sesión; mismo hash completado no reimporta. TTL temporal propuesto de 30 días, aviso, EXPIRED/410, cancelación y limpieza futura dejan catálogo idéntico; auditoría/ledger no se borran por ese TTL. |
| P05 | Unit/integración | Códigos con ceros, acentos, espacios, coordenadas inválidas/NaN, lat/lon invertidas, jerarquía anidada: normalización reversible y diagnósticos deterministas. |
| P06 | Matcher/DB | Bordes 0/50/250/>250 m; par a 40 m y 200 m; clientes distintos en coordenada idéntica; códigos repetidos y copias Heredia. Bandas configurables generan candidatos explicables, nunca identidad ni fusión automática; mover umbrales cambia matcher_version. |
| P07 | API | EXISTING_MATCH, conflicto, vínculo manual, exclusión y UPDATE_SELECTED_FIELDS: exigir destino, versión, motivo, lista permitida y aprobación; mostrar antes/después, preservar campos ausentes del KMZ y original inmutable. |
| P08 | Concurrencia | Catálogo actualizado tras MATCH: validate/confirm devuelve REBASE_REQUIRED; nuevo match presenta diff y no borra decisión humana. |
| P09 | Fixture KMZ | Diez sitios fuera de Costa Rica dos veces, 650 puntos de clientes, 215 paradas, 763 Placemark poligonales y una línea: advertencias correctas; geometrías D-04 solo en staging, sin cliente/ruta/visita automática. |
| P10 | E2E/accesibilidad | Filtros, tabla ↔ mapa, comparación triple, teclado/foco, geometría inválida, sin teselas, 2 admins editando fila: revisión consistente y accesible. |
| P11 | Integración rutas | Agrupación no crea ruta; DRAFT_ROUTE exige vínculo explícito de cada parada con cliente/pin confirmado; SEMANA no implica calendario, recurrencia o vigencia. Ruta permanece DRAFT y ninguna visita se genera ni altera historia. |
| P12 | API | Plan exacto por entidad/acción; INVALID aplicable, conflicto sin resolver, falta de permiso o ETag obsoleto bloquean confirm. |
| P13 | DB/API | Fallo inyectado antes de cada operación/commit: rollback completo de catálogo, grupos, ruta, ledger y auditoría de éxito. |
| P14 | DB/API | Timeout después de commit y reintento con mismo key/digest: un commit, misma respuesta, ningún duplicado; key con otro digest falla. |
| P15 | Concurrencia | Dos administradores confirman misma sesión y dos importaciones comparan mismo catálogo: uno gana, otro rebase/conflicto; sin cambios parciales. |
| P16 | Rendimiento/seguridad | Propuestas D-05 (32/128 MiB, 128 entradas, profundidad/elementos/vértices) se prueban en worker aislado: rechazo temprano y acotado sobre cuota, muestra dentro de cuota, memoria pico, CPU, tiempo, concurrencia y p95 medidos. Fijar máximos operativos solo con evidencia; medir falso rechazo de ZIP legítimo. |
| P17 | Seguridad/auditoría | read/write/confirm separados y denegados por defecto; admin sin capacidad no accede; grants/revocación, CSRF/origen, redacción de logs; ledger reconstruye originales, correcciones, actores y resultado. TTL borra solo archivo/staging según política aprobada. |
| P18 | Regresión GPS | Snapshot de position_event, políticas, sesiones y visitas históricas antes/después; posiciones fuera de ruta siguen legibles; pruebas GPS existentes sin regresión. |
| P19 | Catálogo W1 | Fuente KMZ no puede crear customer; CSV/XLSX autorizado con namespace único sí; establecimiento candidato sin cliente es válido; dos clientes distintos en misma coordenada; FK/GiST/versiones/catalog_revision y migración sin grants automáticos. |

## Criterios de cierre

W1: P19 más P08/P11/P17/P18 para esquema y compatibilidad; W2: P01–P05/P16; W3: P05–P09; W4: P07/P10/P11; W5: P08/P12–P15/P17/P18; W6: P01–P19 con fixture real autorizado y reconciliación de conteos. Para CA-06/07 se exige evidencia SQL antes/después y simulación de timeout, no solo mocks. El KMZ de Downloads no se copia a tests ni a Git sin autorización y tratamiento de datos. Fallos conocidos se documentan por ID y dejan gate abierto.

**Ejecución W1-A inicial:** dos pruebas nuevas de integración en bases geops_verify_1109 y geops_verify_1110; API 32 pruebas, Web 41, GPS 45 verificaciones y administración de usuarios 42 verificaciones. Se probaron migración limpia, actualización 0015→0016 con rollback inducido, CAS 200/409, FK/unicidad, estados DRAFT/CANDIDATE, grants denegados por defecto y auditoría. Comandos, entorno y límites en [w1-a-evidence.md](w1-a-evidence.md).

**Corrección W1-A-R:** [catalog-w1ar.integration.mjs](../../apps/api/test/catalog-w1ar.integration.mjs) cubre H-01–H-03 y M-01–M-02 con carrera archive/asociación, ocho denegaciones paralelas, auditoría idempotente por request_id, fallo de audit_event, historial de vínculo, CRUD selectivo, CSRF/origen y rollback. [catalog-w1ar-upgrade.integration.mjs](../../apps/api/test/catalog-w1ar-upgrade.integration.mjs) cubre 0016→0017 con fallo inducido e historia conservada; el test anterior cubre 0015→0017. Resultados, entorno y límite de empresa única en [w1-a-r-evidence.md](w1-a-r-evidence.md). El lint global heredado permanece como gate A-07 PARTIAL.
