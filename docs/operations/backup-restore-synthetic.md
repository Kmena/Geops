# Backup y restauración sintéticos — GEOPS Wave 0A

Aplicable únicamente a la base GEOPS de desarrollo con datos ficticios. El backup contiene hashes, claves públicas, evidencia y tokens de prueba cifrados; conservarlo en almacenamiento local autorizado y no incorporarlo a Git.

1. Detener la API GEOPS antes de restaurar. Confirmar la base de destino exacta, su carácter desechable y el checksum de migraciones.
2. Tomar `pg_dump` del contenedor `geops-wave0a-db` y restaurar con `pg_restore` en una **base nueva**. No sobrescribir `geops_dev` durante pruebas. Comprobar PostGIS y las seis migraciones.
3. Antes de permitir tráfico, consultar estado de dispositivos, claves y sesiones. Si el backup es posterior a una revocación, comprobar que el dispositivo continúa `REVOKED`, no existe clave activa y no hay sesión vigente; ejecutar `restore-check.mjs` con `GEOPS_TEST_DB` de la base restaurada.
4. Si el backup puede ser anterior a una revocación, mantener la API detenida. Una restauración antigua no contiene necesariamente el evento de revocación: reconciliar con un registro externo confiable o invalidar todas las claves y sesiones y repetir ceremonias de enrolamiento. Este mecanismo operativo todavía no está implementado ni probado; **no** reabrir acceso de dispositivos con una copia antigua.
5. Registrar fecha, entorno, migraciones, conteos y resultado sanitizado. Eliminar únicamente las bases y dumps desechables creados para la prueba tras guardar evidencia.

La prueba local del 2026-10-16 restauró una copia posterior a revocación y rechazó el challenge del dispositivo; no demostró recuperación segura desde una copia anterior ni validación en producción.
