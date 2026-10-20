# SPEC-02 — gate final de release para 0015

**Decisión actual: `BLOCKED` para publicación y Staging.** El ensayo local con datos sintéticos pasa, pero no existe revisión de seguridad independiente ni evidencia de la copia aislada del estado observado de Staging. Se prepararon commits locales para revisión; no hubo push, merge ni despliegue.

## Ensayo manual reproducible en Ubuntu

El [script](../../scripts/release-0015/ubuntu-rehearsal.sh) **no se conecta a Staging**. Un operador autorizado obtiene, por el procedimiento de backup aprobado, un dump PostgreSQL custom (`pg_dump -Fc`) de la base en 0014 y lo custodia fuera del repositorio en un host privado. El archivo y el directorio de evidencia deben pertenecer al operador, tener permisos sin acceso de grupo/otros y quedar fuera de rutas públicas. No pasar credenciales, dump, sesiones, gate ni posiciones por tickets o CI.

```bash
mkdir -m 700 /ruta/privada/evidencia-0015
chmod 600 /ruta/privada/staging-0014.dump
sha256sum /ruta/privada/staging-0014.dump
bash scripts/release-0015/ubuntu-rehearsal.sh \
  --dump /ruta/privada/staging-0014.dump \
  --sha256 HASH_DE_64_HEX_OBTENIDO_POR_EL_OPERADOR \
  --evidence-dir /ruta/privada/evidencia-0015 \
  --confirm ISOLATED_0015_REHEARSAL
```

Ejecutar desde un checkout GEOPS de `codex/spec-02-wave-1`, con Docker local por socket Unix, PostGIS `18-3.6`, Node de la imagen de ensayo y espacio tmpfs suficiente. El script registra SHA de Git, si el árbol estaba sucio, SHA del dump e IDs de ambas imágenes. No toma ni exporta secretos de Staging, no publica puertos, no inicia API/Web y no guarda el dump en la imagen. La red Docker es interna; la base solo vive en tmpfs. Ante cualquier error se registra `BLOCKED` con la etapa, se destruyen contenedor, red, imagen temporal y archivos de trabajo. Si el proceso recibe SIGKILL o falla el host, un operador debe localizar y retirar solo los recursos `geops-0015-rehearsal-*` tras verificar su identidad; no se autoriza abrir el gate.

La copia restaurada conserva credenciales únicamente mientras está aislada para comprobar 14 checksums, epoch y conteos. El migrador compilado aplica 0015; el verificador exige 15 checksums y los mismos conteos de identidades, concesiones, posiciones, salud y auditoría. Luego se crea un gate nuevo **cerrado** para la copia. La prueba de reapertura exacta antes de cuarentena debe fallar. La cuarentena bloquea usuarios, sesiones, claves, custodios, invitaciones y concesiones, rota epoch y deja el gate cerrado; una reapertura sin autorización también debe fallar. La base de ensayo se destruye al terminar; el dump de entrada sigue bajo custodia del operador para su eliminación según el procedimiento aprobado. La evidencia persistente contiene solo hashes y agregados, nunca tokens, correos, coordenadas ni contraseñas.

En otras bases sintéticas independientes, el mismo contenedor ejecuta fallo SQL transaccional, reintento, interrupciones antes y después del COMMIT, pérdida del gate, marcador alterado, replay, concurrencia y regresiones autenticadas de capacidades, tenant y usuarios. Los archivos `pre.json`, `post.json`, `integrity.json`, `gate-before.json`, `gate-after.json`, `synthetic-results.txt`, `source.json` y `result.json` se conservan en el directorio privado de evidencia. **`result.json=PASS` no sustituye aprobación de Seguridad ni autoriza Staging.** Si `working_tree_dirty=yes`, la evidencia es diagnóstica; repetir sobre SHA limpio antes de la aprobación final.

## Matriz de fallo y recuperación

La [matriz operativa](migration-0015-safe-recovery-2026-10-20.md) cubre antes de cierre, cierre incompleto, antes/durante/después de COMMIT, error al reabrir, API incompatible, reinicio, pérdida del volumen y backups a ambos lados de 0015. La acción permitida para 14 íntegro bajo gate `maintenance` es recuperación supervisada hacia adelante; para 15 confirmado es validación y apertura supervisada sin repetir SQL. Un marcador/epoch/OID discordante detiene el proceso. Un backup restaurado se trata en base nueva con cuarentena y credenciales nuevas; no se restaura en sitio ni se reutiliza el gate previo.

## Paquete para revisión independiente

Revisar juntos el [motor de recuperación](../../apps/api/src/db/maintenance-recovery.ts), [gate y vínculo OID](../../apps/api/src/db/maintenance-gate.ts), [cuarentena](../../apps/api/src/db/restore-quarantine.ts), [prueba de fallos](../../apps/api/test/maintenance-recovery.integration.mjs), [prueba de restore](../../apps/api/test/single-tenant-release-restore.integration.mjs), [ADR-019](../architecture/adr/ADR-019-empresa-unica-administracion-por-capacidades-propuesto.md), este script y los JSON agregados del operador.

Seguridad debe decidir y registrar: separación real de principal/custodios, custodia y destrucción del dump privado, ausencia de restore *in situ* o snapshot físico que conserve OID, compatibilidad del digest de imagen con 0015, y tratamiento de una falla de API después de abrir. Aprobar explícitamente el límite de recuperación hacia adelante, la indisponibilidad eventual y la cuarentena que invalida credenciales restauradas. No declarar revisión independiente con solo las pruebas del autor.

## Evidencia local de Codex y gates restantes

En PostGIS desechable sin puertos públicos: imagen de ensayo compilada; dump **sintético** 0014 restaurado y migrado a 0015; mismos conteos de administrador, sesiones, nueve permisos y tres eventos de auditoría antes/después; gate cerrado y reapertura exacta rechazada antes de cuarentena; credenciales revocadas, epoch rotado y apertura sin autorización rechazada después. Fallo transaccional 0015: PASS; recuperación supervisada: **27 comprobaciones PASS**; bootstrap de capacidades: **19 PASS**; tenant: **41 PASS**; usuarios: **42 PASS**. El script Ubuntu se validó sintácticamente, pero **no se ejecutó con un dump de Staging** ni de principio a fin bajo Ubuntu. La ejecución integral queda pendiente para el operador.

Gates para pasar a revisión de publicación: árbol Git limpio y commits por alcance; escaneo de secretos, Node/Web, build, typecheck, lint, contratos, PostgreSQL y CI sobre SHA; ensayo Ubuntu con dump aprobado y evidencia privada; revisión independiente firmada de ADR-019 y recuperación; comprobar rama remota sin divergencia. Publicar solo `codex/spec-02-wave-1` después de esos gates. Publicación no autoriza migración ni despliegue.
