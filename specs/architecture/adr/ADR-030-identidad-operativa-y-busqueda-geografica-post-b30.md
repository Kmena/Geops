# ADR-030 — Identidad operativa del agente y búsqueda geográfica post-B30

Estado: aceptada para implementación local; despliegue pendiente.

## Contexto

B30 relaciona `agent`, `geops_device`, `agent_device_link`, asignaciones y posiciones por tiempo de captura. El uso administrativo necesita que el agente represente al dispositivo estable y que el nombre de la persona responsable pueda cambiar sin reinterpretar la historia. El catálogo también necesita buscar lugares para situar una sede sin exigir coordenadas manuales.

## Decisión

Se mantiene `agent` como identificador de rutas y evaluaciones y se añade `agent_operational_identity`, uno a uno con un dispositivo GEOPS ya registrado y autorizado. El identificador MDM sigue siendo metadato de vinculación, no identidad canónica. Los vínculos B30 existentes se conservan y los activos se incorporan a la identidad operativa en la migración 0031. `agent_responsibility` guarda intervalos de persona, actor y motivo sin solapamiento; solo se puede cerrar el intervalo vigente, sin borrar o editar historia.

El administrador registra un agente desde un dispositivo real ya existente. Las rutas siguen apuntando al agente. La atribución GPS continúa usando `agent_device_link` y `captured_at`; el cambio de persona no modifica evaluaciones previas.

La búsqueda de lugares usa el endpoint administrativo GEOPS, que consulta el servicio público Nominatim solo al pulsar Buscar. El usuario autorizó expresamente el envío del texto a `https://nominatim.openstreetmap.org/search`. Se informa ese envío en la interfaz. El backend fija la URL, identifica la aplicación, limita a una consulta por segundo entre réplicas, limita cada administrador a 20 consultas por minuto, acota tamaño y duración de respuesta y conserva 24 horas los resultados asociados a un hash de consulta. No hay autocompletado ni envío por tecla. Leaflet permite seleccionar y arrastrar el marcador; la dirección sugerida solo se aplica por acción explícita. La entrada manual permanece disponible.

## Consecuencias

La migración 0031 es aditiva y no altera 0001–0030 ni el protocolo GPS. Los agentes B30 sin vínculo activo siguen visibles como legado y requieren conciliación administrativa. La búsqueda pública requiere conectividad y su cuota puede ser insuficiente para una operación de alto volumen; se podrá desactivar con `GEOPS_GEOCODING_DISABLED=YES` y sustituir por un proveedor compatible mediante una decisión posterior. No hay evidencia física nueva y el despliegue requiere una promoción separada.
