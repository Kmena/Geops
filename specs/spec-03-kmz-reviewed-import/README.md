# SPEC-03 — Importación revisable de KMZ

**Estado:** W0_PARTIAL; W1-A implementada y corregida en rama aislada W1-A-R; reauditoría READY_WITH_CONDITIONS por lint global heredado. W1-B y W2–W6 pendientes. **Corte:** 2026-11-03. D-01–D-08 permanecen en [decisions.md](decisions.md). [w1-a-evidence.md](w1-a-evidence.md) conserva el resultado inicial; [w1-a-r-evidence.md](w1-a-r-evidence.md) y [w1-a-audit.md](w1-a-audit.md#reauditoría-w1-a-r--2026-11-03) registran las correcciones y gates actuales. No hubo despliegue ni migración operativa.

## Objetivo

Un administrador carga un KMZ a una sesión temporal, compara sus elementos con el catálogo, corrige y resuelve diferencias, y confirma una publicación transaccional, auditable e idempotente. Cargar, analizar, revisar o cancelar no modifica clientes, rutas, geozonas, GPS ni visitas operativas.

Esta SPEC desarrolla RF-08, RF-10, RF-12 y RF-15 del [PRD](../prd/GEOPS-PRD-v1.1.md). Agrupación geográfica, ruta operativa, parada semanal, cliente, pin, visita planificada, posición GPS y visita evaluada son entidades distintas. No se convierten automáticamente unas en otras.

| Documento | Función |
| --- | --- |
| [requirements.md](requirements.md) | Requisitos, trazabilidad y aceptación |
| [design.md](design.md) | Diagnóstico actualizado, arquitectura, datos, reglas, UX y preparación de W1 |
| [api-contracts.md](api-contracts.md) | Contratos REST propuestos |
| [test-plan.md](test-plan.md) | Casos, gates y evidencia |
| [plan.md](plan.md) | Waves, dependencias y gates G0-01–G0-08 |
| [tasks.md](tasks.md) | Trabajo implementable futuro |
| [decisions.md](decisions.md) | Registro formal de decisiones aprobadas, parámetros pendientes, medición KMZ y riesgos |
| [w1-a-evidence.md](w1-a-evidence.md) | Implementación y validación técnica de W1-A |
| [w1-a-audit.md](w1-a-audit.md) | Auditoría original y reauditoría de W1-A-R |
| [w1-a-r-evidence.md](w1-a-r-evidence.md) | Correcciones, migración 0017, pruebas y riesgos residuales |
| [w1-a-r2-evidence.md](w1-a-r2-evidence.md) | Preparación aislada 0019/0020, reconciliación GPS/MDM y gates de integración |

## Evidencia del archivo de referencia

Se inspeccionó en modo solo lectura **Rutas y clientes beta.kmz**, accesible en Downloads pero ausente del repositorio. SHA-256: 158569b893f22a5c9644f8317e1159e7584a49a53469e48d1c2d2d1bf3498ca5. ZIP y XML se leyeron correctamente. Contiene 2.012 Placemark: 1.248 con Point, 763 con Polygon y uno con LineString. Se identificaron 650 puntos en diez carpetas de clientes; 216 elementos de rutas semanales (215 puntos y una línea); 100 puntos de sedes; y 282 puntos en Natalia 2. Hay cinco códigos de cliente repetidos, una entrada sin código, copias de Heredia y 20 apariciones de diez puntos de demostración fuera de Costa Rica. [D-05](decisions.md#d-05--cuotas-de-carga) registra tamaño, profundidad y complejidad medidos y propone cuotas iniciales aún no validadas para producción. Estas cantidades describen este archivo, no límites rígidos. La validación reproducible futura requiere un fixture autorizado o una copia controlada con este hash; el KMZ no se incorpora a Git ni al catálogo con esta SPEC.

Los códigos del KMZ no acreditan cédula comercial. Tampoco contienen por sí solos calendario, vigencia, dispositivo y vínculo inequívoco de cada parada con un cliente. La importación nunca modifica evaluaciones históricas de visitas.

Se auditaron implementación real, migraciones 0001–0015, Web, contratos, SPEC-00/01/02 y ADR-003/009/010/011; [design.md](design.md#1-diagnóstico-actual) separa evidencia de intención documental. No se modificaron specs anteriores ni ADR. [W0](plan.md#evaluación-de-gates-w0--2026-11-03) queda PARTIAL por falta de muestra/diccionario comercial. La autorización posterior W1_A_AUTHORIZED_FOR_IMPLEMENTATION permitió implementar solo la infraestructura base descrita en [w1-a-evidence.md](w1-a-evidence.md). D-02 requiere calibración, D-05 prueba de recursos, D-06 política y D-07/D-08 responsables/campos para waves posteriores.
