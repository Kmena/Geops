# SPEC-03 + MDM — integración controlada

**Fecha:** 2026-10-26. **Estado:** `INTEGRATION_PARTIAL`. La combinación de código, el esquema 0027 y las regresiones locales pasan en la rama temporal. Los procedimientos B23 de publicación y recuperación supervisada siguen fijados al esquema 0023; por ello esta rama no es autorizable para despliegue.

`DEPLOYED = NO` · `PUSHED = NO` · `MERGED = NO` · `WAVE4B = PENDING`

## Procedencia y aislamiento

| Elemento | Evidencia |
| --- | --- |
| Base MDM | `origin/main` = `f1b0aa8d3662c25634820ba5b9bf762433580a77`, cotejado con `git ls-remote origin refs/heads/main`. Contiene OAuth, inventario ManageEngine y migraciones hasta `0023_mdm_oauth_client.sql`. `codex/mdm-oauth-release` apunta al mismo commit. |
| SPEC-03 original | `codex/spec03-wave1`, HEAD `26efc9a39d1a1c95ede6cb353656e3c54bfd92cf`, worktree `C:/Users/kmena/.codex/worktrees/geops-clients-routes-sdd/Geops`. Waves 1–4A estaban sin commit. |
| Candidato | `codex/spec03-mdm-integration` en `C:/Users/kmena/.codex/worktrees/spec03-mdm-integration/Geops`. Se creó desde la base MDM y se aplicó el parche SPEC-03 con `git apply --3way`; los archivos nuevos se copiaron desde el respaldo verificado. |
| Checkout principal | `C:/Users/kmena/Documents/proyectos/Geops`, rama `codex/spec-02-wave-1`, HEAD `26efc9a`, con cambios previos de SPEC-02/documentación. No se modificó. |
| Otros worktrees | `Geops-integration` contiene cambios Web ajenos; no se modificó. |

Respaldo: `C:/Users/kmena/AppData/Local/Temp/geops-spec03-backup-20261026124438`. Contiene `base.tar`, `overlay/`, `reconstructed/`, `spec03-tracked.patch` y `manifest.json`. El manifiesto SHA-256 (`a760b3afd09560100d53ce5ebb3be004df0c167cf4f5054dc47f5de0d73eacbb`) registra 59 archivos; se verificaron sus hashes tanto en la reconstrucción como, al final, en el worktree original: **59/59 idénticos, 0 divergencias**. El respaldo está fuera del repositorio y no contiene datos reales.

## Integración Git y conflictos

Se conservaron todos los cambios funcionales de ambos frentes. `git ls-files -u` quedó vacío y no hay marcadores de conflicto.

| Archivo | Resolución |
| --- | --- |
| `apps/api/package.json` | Se conservó la suite MDM y se agregó el test unitario de permanencia. |
| `apps/api/src/admin-auth/user-administration.ts` | Permisos MDM OAuth y permisos SPEC-03 en la misma lista. |
| `apps/api/src/app.ts` | Rutas MDM/GPS e inventario con su contrato original, junto a clientes, rutas, asignaciones y evaluaciones. Se mantuvo la condición MDM de inventario opcional. |
| `apps/api/src/main.ts` | Inicialización y continuidad MDM/GPS junto a los nuevos servicios SPEC-03. |
| `apps/web/src/AdminUsers.tsx` | Catálogo combinado de permisos. |
| `apps/web/src/api/client.test.ts` | Tests MDM originales más los de cliente/ruta SPEC-03. |
| `apps/web/src/app.tsx` | Navegación MDM restringida, rutas SPEC-03 y encabezados sin duplicación. |

`apps/web/src/api/client.ts` y `apps/web/src/styles.css` aplicaron limpiamente con Git. No se escogió una versión completa de los archivos conflictivos. No se modificaron captura Android, protocolo GPS v2, ACK, `mdm_binding` ni código de despliegue.

## Migraciones y datos

Las 23 migraciones MDM/GPS originales permanecen byte por byte como en la base. Las cuatro migraciones SPEC-03, todavía no aplicadas en entornos persistentes, se renumeraron solo aquí:

| SPEC-03 original | Integración | SHA-256 integrado |
| --- | --- | --- |
| `0022_client_geofences.sql` | `0024_client_geofences.sql` | `5b2a1cdfc479cf63057fc1081b81d76133d4e0fbcf10308170d3514168a573be` |
| `0023_route_catalog.sql` | `0025_route_catalog.sql` | `8e53fb4beddafe36be9a192221f4c324be18b0317fce7f339730a604566b4a06` |
| `0024_agents_assignments.sql` | `0026_agents_assignments.sql` | `02d793841115f23da07fc0d43a71729415b57369996dc728663b84d9b84ea115` |
| `0025_visit_dwell_engine.sql` | `0027_visit_dwell_engine.sql` | `ebc405d652b8e902e4031d49fb5ad8d1630d12a4d5b76be662840f7e9fc23898` |

Las migraciones 0024, 0026 y 0027 amplían el CHECK de `admin_permission` conservando `mdm.oauth.configure`; ninguna concesión existente se revoca. La secuencia 0024–0027 respeta las dependencias cliente → ruta → asignación → evaluación, FKs compuestas por tenant, índices y triggers históricos. Se actualizaron las expectativas de versión de las fixtures; los documentos de cierre de Waves 1–4A conservan su numeración histórica con nota de correspondencia.

En PostGIS 18-3.6 **sin volumen**: instalación desde cero de 27 migraciones; actualización de 23 a 27 con filas MDM y permisos sintéticos preexistentes; checksums de 1–23 idénticos antes y después; `checkReadiness = true`; segunda aplicación vacía; pruebas de actualización 22→27, 16→27 y 14→27. Las suites de Waves 1–4A verifican integridad, aislamiento, snapshots y auditoría sobre el esquema combinado. Cada base se llamó `geops_verify_*` y se destruyó con el contenedor. No se tocó una base persistente.

## Verificación

| Prueba | Resultado |
| --- | --- |
| `npm test` | PASS, salida 0: API, Web, contratos, migración de destino, restore y release 0015. |
| `npm run build` y `npm run typecheck` | PASS, API, Web y contratos. |
| `npm run lint` | PASS, salida 0; 14 advertencias preexistentes de aserción no nula en GPS. |
| Biome `lint` sobre 38 archivos de código modificados/nuevos | PASS, 0 errores. El `biome check` amplio encuentra seis discrepancias de formato en fixtures MDM/SPEC-03, sin errores de reglas; no se reformataron fixtures históricos en masa. |
| Wave 1 PostGIS / Chrome | 57/57 + 15/15 PASS. |
| Wave 2 PostGIS / Chrome | 76/76 + 14/14 PASS. |
| Wave 3 PostGIS / Chrome | 70/70 + 20/20 PASS. |
| Wave 4A unitarias / PostGIS | 12/12 + 40/40 PASS. Solo motor sintético de laboratorio. |
| GPS políticas / salud / operaciones | 48/48 + 37/37 + 58/58 PASS. |
| MDM/GPS adicional | 16/16 scripts PASS en bases separadas: actualización MDM, OAuth, inventario, seguridad, inscripción sintética, GPS configuración/eventos/lotes/continuidad, carga de 25 dispositivos, capacidades y administración de tenant/usuarios. `gps-events`: 69; `gps-mixed`: 64; `gps-continuity`: 44 aserciones. |

Reproducir: `pwsh -NoProfile -File scripts/run-spec03-browser-e2e.ps1` y `pwsh -NoProfile -File scripts/run-spec03-mdm-integration.ps1`. Ambos usan contenedores PostGIS descartables, puertos loopback y datos sintéticos. Un intento inicial del segundo runner reveló que siete tests existentes requieren migración previa; se corrigió la preparación de la fixture y la ejecución final pasó 16/16. El intento inicial del runner de navegador se lanzó por PowerShell 5, que no admite `Start-Process -Environment`; con `pwsh` pasó completo.

## Límites de publicación y recuperación

1. `scripts/deploy/create-manifest-v2.mjs` es el manifiesto inmutable B23. Exige exactamente 23 migraciones y el hash B23. Con el catálogo integrado rechaza `27 !== 23` (verificación local). Mantener esta protección evita publicar 0024–0027 como si fuesen el release B23; se necesita un nuevo contrato/manifiesto y ensayo de despliegue para un release futuro.
2. `apps/api/src/db/maintenance-recovery.ts` acepta esquemas 14–23 y exige un catálogo de exactamente 23. El binario integrado con 27 rechazaría la recuperación supervisada. Se requiere extensión específica, pruebas de recuperación y aprobación antes de integración oficial.
3. No se ejecutó pipeline remoto, publicación de imágenes, migración persistente ni despliegue. Las pruebas sintéticas no validan operación MDM real ni GPS físico.

Estos dos puntos impiden `INTEGRATION_PASS` y son la razón concreta de `INTEGRATION_PARTIAL`; no se cambiaron políticas de despliegue para hacerlos pasar artificialmente. No se observaron regresiones en los servicios y pruebas locales ejecutados.

## Identidad agente–dispositivo para Wave 4B

`geops_device.id` es el identificador estable del dispositivo GEOPS. `mdm_binding.id` representa la asociación y `mdm_device_id` es el identificador externo del proveedor, acotado por `provider` + `customer_id`. El inventario ManageEngine aporta conciliación administrativa, no una relación histórica agente–dispositivo. El modelo de inscripción y algunas rutas GPS aún exigen un `mdm_binding` activo; las pruebas sin ManageEngine usan el proveedor sintético `fake`. Por ello no hay todavía una vía física comprobada de GPS sin MDM.

Wave 4A usa `visit_lab_agent_device_link` temporal, inmutable y `LAB_ONLY`, sin FK a `mdm_binding`; no sirve para atribución productiva. Wave 4B debe definir una relación agente ↔ `geops_device.id` con `[valid_from,valid_to)`, tenant, procedencia y prueba de autorización, exclusión de solapamientos, historial inmutable y cambio de teléfono con cierre/apertura explícitos. La evidencia MDM puede corroborar un dispositivo cuando exista, pero el contrato debe admitir otro método aprobado sin ManageEngine. Las posiciones fuera de una relación temporal válida deben quedar `UNATTRIBUTABLE`; coincidencia de horario o inventario MDM por sí solos no prueban el agente. Hace falta validar la transición de binding/tenant GPS y la operación sin MDM antes de activar Wave 4B. No se implementó Wave 4B.

## Decisión

`INTEGRATION_PARTIAL`: rama temporal lista para revisar la combinación de código y el esquema local, pendiente de un release posterior a B23 con manifiesto, recuperación supervisada y ensayos de despliegue compatibles con 27 migraciones. Waves 1–4A conservan su PASS **local y sintético**; MDM/GPS conserva PASS en las suites ejecutadas. Sin autorización de producción ni validación GPS física.
