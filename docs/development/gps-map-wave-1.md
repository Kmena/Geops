# Mapa GPS — Leaflet y teselas para Wave 1

GEOPS Web usa Leaflet 1.9.4 para marcadores, recorrido cronológico, precisión y selección. Reutiliza de la PoC la inicialización `L.map`, `tileLayer`, `layerGroup`, `polyline`, `circleMarker`, `fitBounds` y `remove`, adaptados al ciclo de vida React. Leaflet es el único motor cartográfico activo. La tabla accesible contiene captura, recepción, retraso, precisión y coordenadas incluso si el mapa falla.

## Fuente de teselas

La PoC utiliza `https://tile.openstreetmap.org/{z}/{x}/{y}.png`; esa misma URL es el valor predeterminado del piloto Web, según la decisión del usuario. Las teselas públicas de OSM tienen capacidad limitada, no tienen SLA, exigen atribución, `Referer` y caché, y pueden bloquear el acceso. Véanse la [política de teselas OSM](https://operations.osmfoundation.org/policies/tiles/), las [directrices de atribución](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines) y la [decisión del piloto](leaflet-osm-pilot-2026-10-20.md).

Web solicita teselas solo cuando el mapa es visible y hay posiciones. `VITE_GPS_TILE_URL` puede fijarse explícitamente en `https://tile.openstreetmap.org/{z}/{x}/{y}.png` o en una ruta local aprobada que sirva datos OSM, como `/maps/tiles/{z}/{x}/{y}.png`; sin variable se usa la URL estándar de OSM. Se rechazan HTTP, otros hosts externos, parámetros y plantillas sin los tres índices. Un futuro cambio de fuente exige revisar la atribución y la política correspondiente.

OSMF recibe IP, origen de Staging y zona cartográfica visible mediante índices XYZ; no recibe IDs de dispositivo ni la lista de posiciones como parámetros. La política de privacidad de GEOPS debe reflejar ese tercero. El mapa se inicializa al entrar en el viewport y se desmonta al salir, sin precarga ni actualización periódica. Una fuente fuera de línea no impide consultar la tabla; el error de teselas se muestra sin eliminar puntos o recorridos. La configuración Nginx Web de Staging debe permitir imágenes de `tile.openstreetmap.org` y enviar `Referer`; la corrección está preparada en el repositorio, pero aún no desplegada.

`VITE_GPS_TIME_ZONE` establece la zona inicial; el valor predeterminado es `America/Costa_Rica`. El usuario puede elegir Costa Rica, Guatemala o UTC. Cada consulta de ubicaciones cubre como máximo 24 horas con fin exclusivo. El recorrido se corta cuando transcurren más de cinco minutos o cambia la sesión; no se interpola una línea sobre un hueco.

## Datos y límites

El estado de identidad en `/v1/admin/gps-devices` solo cubre identidades activas. La API no informa cuántas lecturas permanecen pendientes en el teléfono ni un evento de sincronización completa; la interfaz indica «No disponible». La antigüedad se calcula desde `captured_at`, no desde `received_at`. Una ausencia de posiciones no demuestra pérdida de señal: Android puede no entregar una lectura o sincronizar después. Las coordenadas nunca se envían a un proveedor externo de teselas mediante parámetros; solo se solicitan los índices de tesela del área visible cuando se configure una fuente.

## Actualizar solo Web

1. Mantener la rama y los cambios locales existentes; revisar `git status`.
2. Instalar dependencias con `npm ci` en la raíz y ejecutar `npm run build --workspace @geops/web`.
3. Dejar sin definir `VITE_GPS_TILE_URL` para usar OSM o fijarla explícitamente en la URL estándar anterior. Verificar que `infrastructure/nginx/geops-staging-web.conf` contiene `img-src ... https://tile.openstreetmap.org` y `Referrer-Policy: strict-origin-when-cross-origin`.
4. Publicar el artefacto Web **y la configuración Nginx Web** mediante el procedimiento existente del entorno. No se modifica API, Android ni base de datos. Esta tarea no despliega ni accede a AWS.
5. Validar sesión, autorización `gps.location.read`, mapa, tabla, atribución y carga de teselas en Staging.
