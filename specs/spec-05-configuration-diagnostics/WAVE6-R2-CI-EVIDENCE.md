# W6-R2 — Evidencia CI remota y publicación

Fuente de aplicación inmutable: `809bb0678feaefdbbe8006a1ba05325ccb1ad0a8`. Rama aislada: `codex/mdm-diagnostics-wave0`. Commit del workflow/runner aprobado: `3a5c5be43905e8875db94bbbc3fc7701c8287da1`. El diff desde la fuente son solo `.github/workflows/spec05-w6-r2-publish.yml` y `scripts/run-spec05-wave5-browser-e2e.ps1` (170 inserciones, 7 eliminaciones); no cambia API, Web, Android ni SQL. El runner añadió `RepoRoot`, compatibilidad de proceso Linux y uso del binario Playwright instalado.

| Gate | Resultado observado |
| --- | --- |
| Triggers/gates | Los workflows de despliegue existentes no reciben push de esta rama; el nuevo workflow solo hace validación y publicación GHCR. No contiene SSH, staging deploy ni producción. La publicación depende del job `validate`. |
| Run remoto | [GitHub Actions 46164447870](https://github.com/Kmena/Geops/actions/runs/46164447870), evento push del commit `3a5c5be`; validación de 2026-11-28 16:18:34–16:20:23 UTC: **PASS**. |
| Fuente exacta | Checkout `target` igual a `809bb067...`, promoción descendiente, 42 SQL. |
| Static/unit | `npm ci`, typecheck, lint, contratos, escaneo de seguridad, pruebas API/Web y build API/Web con MDM visible: PASS. |
| Staging config | `staging:check` y `staging:caddy:check`: PASS. |
| PostGIS/GPS/MDM | PostGIS `18-3.6` descartable, diagnóstico 24 aserciones, política MDM/RBAC/tenant, upgrades/recovery 0035→0042 y GPS mixto 68 aserciones: PASS. |
| Restore sintético | Dump 0040, `pg_restore`, 0041/0042, ledger/identidad/readiness: PASS. Hash efímero del dump en el run: `03a490285568e7b8b38e087a0d33fce50f2fe0e515967cc8895d54ed72e2d1d5`. No es backup real. |
| Chrome E2E | API/Web/PostGIS/mock ManageEngine en loopback, 20 checks: PASS. |
| Imágenes | Job `images` del mismo run, posterior a `validate`: PASS. Publicación API/Web en GHCR y digests en [manifiesto](WAVE6-R2-GHCR-RELEASE-MANIFEST.json). |

Dos intentos previos fallaron **antes de publicar**: [46163875304](https://github.com/Kmena/Geops/actions/runs/46163875304) por comillas YAML en `if`, y [46163966245](https://github.com/Kmena/Geops/actions/runs/46163966245) / [46164214658](https://github.com/Kmena/Geops/actions/runs/46164214658) por resolución `npx --offline` desde directorio temporal en Ubuntu. Los tests anteriores a E2E sí pasaron en esos runs, pero solo `46164447870` cuenta como validación remota integral. Los commits de corrección preservan la fuente de aplicación `809bb067`.

El job de imágenes usa tags de SHA más sufijo W6-R2 y registró refs `@sha256:` en el [artefacto de publicación](https://github.com/Kmena/Geops/actions/runs/46164447870/artifacts/15271132059). Tras `docker pull` por digest se inspeccionaron **ambas imágenes reales**: `linux/amd64`, `org.opencontainers.image.revision=809bb067...`, `org.geops.promotion.commit=3a5c5be...`, `org.geops.schema.target=42` y variantes `SPEC05-W6-R2`. La API publicada contiene 42 SQL y sus archivos 0041/0042 tienen exactamente los SHA-256 esperados; el bundle Web publicado contiene `mdm/workspace/summary`. Fechas de creación, IDs locales y digests de índice OCI constan en el manifiesto. Los labels de las imágenes **activas en staging** aún necesitan inventario privilegiado. No se desplegó staging.
