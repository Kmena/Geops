# Integración MDM y recuperación supervisada 14–18 — 2026-10-21

## Alcance

La rama `codex/geops-integration` incorpora por merge normal la rama
`feature/mdm-manageengine-integration` desde el ancestro común
`5339b811bc2b62274b669ab60ae055718216b6a7`. El catálogo conserva las
migraciones 0001–0017 y añade únicamente `0018_mdm_inventory.sql`. El archivo
0017 es idéntico en ambos orígenes. El vínculo de inventario MDM con
`geops_device` es una referencia administrativa; no concede identidad PoP ni
autoriza capturas GPS.

## Recuperación

`maintenance-recovery.ts` acepta exclusivamente estados completos 14, 15, 16,
17 o 18 y el catálogo exacto de 18 nombres y checksums. Comprueba la presencia
o ausencia de las tablas e índices MDM según el ledger, columnas, nulabilidad,
clave primaria, clave foránea, checks y unicidad del vínculo. Un objeto de 0018
sin ledger o un ledger de 0018 con objeto ausente bloquea la recuperación.

La operación mantiene las comprobaciones existentes de nombre y OID de base,
epoch, nonce, marcador, cuarentena, aislamiento de conexiones, advisory locks,
administrador y dos custodios distintos. Cada migración pendiente se confirma
en su propia transacción. El gate solo abre después de validar el estado 18,
el fingerprint de identidades y la auditoría. En estado 18 se incluyen filas
de inventario MDM y corridas de sincronización en el fingerprint. No se
reaplica SQL cuando la base ya está en 18.

## Evidencia sintética local

Se usó exclusivamente un contenedor PostGIS 18-3.6 temporal con puerto local
aleatorio y bases `geops_verify_*`; `geops_dev` existió solo dentro de ese
contenedor para el ensayo del CLI. No se usó Staging ni otro volumen.

| Ensayo | Resultado |
| --- | --- |
| Desde cero, 18 migraciones | PASS |
| 14→18 con fallos antes/durante/después de COMMIT de 0015–0018 | PASS, 54 comprobaciones |
| 15→18, 16→18, 17→18 | PASS |
| 18→18 con inventario MDM poblado y checksum 0018 alterado | PASS; rechaza alteración y preserva filas |
| 14→18 con CLI compilado, gate y marcador en base desechable | PASS |
| Upgrade poblado 14→18 | PASS |
| Conservación de alerta resuelta 16→18 | PASS |
| Inventario, permisos y rutas MDM sintéticas | PASS |
| Regresiones API/GPS autenticadas | PASS |
| Node/Web, build, typecheck, contratos, lint, escaneo de secretos | PASS |
| Kotlin/JVM y APK debug | PASS; sin teléfono físico |

## Límites

El éxito sintético no valida el tenant ManageEngine real, la edición o scopes
de su licencia, el Huawei P40 ni el comportamiento GPS físico. La revisión de
seguridad de esta integración no equivale a una auditoría independiente. No se
autoriza despliegue, activación MDM ni cambios de política de captura por este
informe.
