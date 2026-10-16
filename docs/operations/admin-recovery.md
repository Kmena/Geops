# Recuperación administrativa supervisada — GEOPS Wave 0A

Solo se permite el ensayo sintético local. La antigua emisión de código con dos nombres libres fue deshabilitada: esos textos no autenticaban a dos personas. No existe endpoint web de recuperación.

## Identidades y reglas técnicas

Cada custodio sintético tiene ID y correo propios, contraseña Argon2id y estado ACTIVE/REVOKED. El solicitante administrativo no puede aprobar su propia recuperación, incluso si tiene una identidad de custodio con el mismo correo. Una solicitud dura 10 minutos; reemplazarla cancela la anterior. Dos custodios distintos y activos deben autenticarse separadamente para aprobarla. Un código aleatorio de uso único se emite únicamente tras ambas aprobaciones. Revocar una aprobación invalida el código ya emitido. Consumirlo cambia contraseña, revoca todas las sesiones administrativas anteriores y deja auditoría. La pérdida/revocación de un custodio cancela las solicitudes en las que participó y exige nuevo aprovisionamiento supervisado; no existe bypass de un custodio.

## Ensayo local, sin personas reales

1. El responsable de pruebas habilita temporalmente `GEOPS_ALLOW_SYNTHETIC_CUSTODIAN_SETUP=YES` **solo** en el comando local. Ejecuta `node /work/apps/api/dist/admin-auth/recovery.js provision <correo-ficticio>` dos veces, cada una con contraseña introducida sin eco. Los dos correos y contraseñas deben ser distintos. Este alta por consola es un fixture de prueba, no una ceremonia operativa aprobada.
2. Ejecuta `node /work/apps/api/dist/admin-auth/recovery.js request <correo-admin-ficticio>` y conserva el ID de solicitud fuera de Git.
3. Cada custodio usa una consola individual para `approve <request-id> <su-correo>` e introduce su contraseña sin eco. Se puede retirar la aprobación con `revoke-approval <request-id> <su-correo>` mientras la solicitud está vigente.
4. Solo con dos aprobaciones vigentes, `issue <request-id>` muestra una vez el código temporal al operador supervisado. `consume` pide código y contraseña nueva sin eco. Verificar que el código no se reutiliza y que las cookies anteriores son rechazadas.
5. Si se pierde un custodio, el operador autorizado usa `revoke-custodian <correo>` con la misma bandera sintética; las solicitudes relacionadas se cancelan. Reprovisionar un sustituto requiere un procedimiento fuera del sistema, revisión de seguridad y dos humanos reales antes de uso operativo.

No pasar contraseñas ni códigos por argumentos, variables de entorno, archivos versionables, tickets o logs. Los comandos son locales en contenedor GEOPS y no cargan OAuth real. El acceso a Docker/DB puede alterar custodios: limitarlo a operadores de desarrollo. Las pruebas automatizadas acreditan separación de identidades, expiración, autoaprobación rechazada, revocación y sesiones antiguas; **no** acreditan que dos personas reales hayan autorizado nada. P09/T08 siguen bloqueados para aprobación operativa.
