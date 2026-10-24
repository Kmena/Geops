# GEOPS: actualización supervisada del controlador v1 a v2

Este procedimiento prepara la instalación; **no autoriza ejecutarla en Staging**. El instalador no despliega imágenes, no aplica SQL y no modifica API, Web, PostgreSQL ni el gate.

## Artefactos revisados

1. Generar la política v2 para el tenant de prueba autorizado con `create-policy-v2.mjs`. Verificar sus perfiles A21 (21 migraciones), B22-safe y B22-mdm (22 migraciones), el `imageTag` A21 y los hashes de todos los archivos.
2. Crear el archivo determinista: `python3 -B scripts/deploy/remote/package-v2.py controller-v2.tar.gz policy-v2.json`. Generarlo dos veces y comparar SHA-256. Incluye controladores, política, bundle y la regla sudo v2 exacta.
3. El firmante autorizado firma **el digest exacto** con `node scripts/deploy/remote/sign-package-v2.mjs controller-v2.tar.gz PRIVATE_KEY controller-v2.sig`. El mensaje firmado es `GEOPS-V2-PACKAGE-SHA256\n<digest>\n`; la clave privada permanece fuera del servidor. El instalador solo acepta la firma verificada por la clave pública ya instalada en v1.
4. Registrar y aprobar por separado SHA-256 del instalador, paquete, firma, controlador v1 instalado y política v1 instalada. Los dos últimos deben provenir del host vivo y se pasan como argumentos de comparación. Una firma del paquete no sustituye la revisión del instalador.

## Preflight e instalación (requiere autorización separada)

1. Confirmar que v1 `verify` pasa, que el estado es A21 sin `previous`, que API/Web/DB están saludables, que el ledger contiene exactamente 21 migraciones y que el respaldo vigente existe. Confirmar que no hay otra operación del controlador. Inspeccionar dueño y modos de `/etc/geops-deploy`, `/var/lib/geops-deploy`, `/usr/local/sbin/geops-deploy` y `/etc/sudoers.d/geops-deploy`.
2. Copiar instalador, paquete y firma revisados a rutas root-only; el instalador debe ser root-owned y ejecutarse desde un árbol sin escritura de `abi`. Comprobar SHA-256 contra los valores revisados. No instalarlo desde un checkout de usuario.
3. En la ventana autorizada, ejecutar como root:

   ```text
   python3 -I /root/geops-install-v2.py install \
     /root/controller-v2.tar.gz PACKAGE_SHA256 /root/controller-v2.sig \
     INSTALLED_V1_WRAPPER_SHA256 INSTALLED_V1_POLICY_SHA256
   ```

4. El instalador verifica firma, inventario tar, política, hashes, estado A21 y ledger antes de preparar v2. Adquiere el mismo lock que v1. Copia v1 y su política/clave/estado/regla a `/etc/geops-deploy-v2/legacy` y escribe los archivos v2 con comparación exacta; nunca sobrescribe una copia diferente. Comprueba `visudo`, ejecuta el preflight v2 de solo lectura y vuelve a comparar el estado operativo. **El único punto de activación es un `os.replace` atómico de la regla `/etc/sudoers.d/geops-deploy`**, que pasa de permitir exclusivamente v1 a permitir exclusivamente v2. El ejecutable y la política v1 permanecen intactos.
5. Verificar fuera del instalador que la regla activa contiene solo `/usr/local/sbin/geops-deploy-v2`; revisar journal `v2-install.json`, hashes, permisos y `visudo -c`. Ejecutar `client-v2.mjs inspect-evidence` y `verify` con autorización; contrastar Docker, PostgreSQL y gate con los valores tomados antes. Aún no ejecutar `prepare`, `deploy`, OAuth ni migración.

## Interrupción y recuperación

- Antes del reemplazo de sudoers, v1 sigue siendo el único controlador accesible a `abi`. El journal `staging`/`ready` y los archivos parciales quedan root-only e inertes.
- Después del reemplazo, todos los archivos v2 ya se comprobaron. Si el proceso termina antes de marcar el journal `active`, repetir **la misma** invocación, con el mismo paquete, firma y hashes v1; la verificación termina la activación. Si un archivo difiere o cambió el estado operativo, el instalador bloquea sin corregirlo por sobrescritura.
- No borrar el journal ni sustituir manualmente archivos. Si no hay evidencia suficiente para reanudar, conservar el gate y el estado de servicios, retirar acceso operativo según el procedimiento de incidente y solicitar revisión supervisada.

## Retorno del controlador a v1

Solo mientras el estado compartido siga en esquema v1 A21, el ledger SQL sea 21 y v1 `verify` pase, un operador root puede ejecutar:

```text
python3 -I /root/geops-install-v2.py return-v1 PACKAGE_SHA256
```

La operación coteja la copia preservada, imágenes A21, salud, ledger y gate; valida la regla v1 y la restaura con `os.replace` atómico. El journal `returning` permite repetir tras interrupción. Con ledger 22, estado v2, mezcla de imágenes o evidencia alterada, el retorno queda bloqueado. Retornar el **controlador** no restaura PostgreSQL ni revierte aplicaciones. La copia v2 queda root-only para auditoría; una reinstalación posterior requiere revisión separada.

## Límites del ensayo local

El laboratorio Linux usa claves, política, secretos y estado sintéticos; inyecta cortes abruptos con `os._exit`, comprueba permisos reales y `sudo`/`visudo`. Las observaciones de API/Web/DB en el ensayo del instalador son sintéticas; el preflight Docker/PostgreSQL efectivo y la instalación sobre el v1 real siguen siendo puertas del operador. No se toca Staging ni se firman aprobaciones operativas.
