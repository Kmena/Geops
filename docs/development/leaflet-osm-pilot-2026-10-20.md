# GEOPS — OpenStreetMap para el piloto de Staging

**Decisión del usuario, 20/10/2026:** usar Leaflet 1.9.4 y las teselas ráster estándar de OpenStreetMap para un piloto limitado de Staging. Se reutiliza la URL de la PoC: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`. No se modifica la PoC ni se realiza un despliegue en esta tarea.

La [política de teselas de OSMF](https://operations.osmfoundation.org/policies/tiles/) permite la visualización interactiva normal de un área visible, pero prohíbe descargas masivas, precarga de áreas y uso sin conexión. Exige atribución visible, un `Referer` válido en Web, identificación normal del navegador y respeto de las cabeceras de caché. El servicio es de esfuerzo razonable, sin SLA, y puede limitar o bloquear el acceso. El origen de Staging y el área vista se revelarán a OSMF; GEOPS no enviará identificadores ni listas de posiciones en las URL de teselas.

## Bloqueo de configuración detectado y corrección preparada

La configuración Web de Staging anterior tenía `img-src 'self' data:` y `Referrer-Policy: no-referrer`. Eso impedía las imágenes externas y omitía el `Referer` requerido. Se corrigió **solo** `infrastructure/nginx/geops-staging-web.conf` para permitir `https://tile.openstreetmap.org` en `img-src` y usar `strict-origin-when-cross-origin`. Así el navegador enviará el origen, sin ruta ni parámetros de la página, en las solicitudes a OSM. `nginx -t` pasó en un contenedor local sin red externa, con el nombre del upstream API resuelto a loopback únicamente para la prueba. La configuración ejecutada en Staging seguirá bloqueando OSM hasta una actualización autorizada del servicio Web.

La cabecera `Cache-Control: no-store` de GEOPS corresponde a las respuestas del propio origen; las imágenes externas de OSM usan sus cabeceras de caché y no reciben cabeceras de solicitud `no-cache` agregadas por GEOPS. No se implementa proxy, descarga previa ni refresco automático. Leaflet se monta únicamente cuando el mapa entra en el viewport y solo añade la capa de teselas cuando hay posiciones. La URL permanece configurable con `VITE_GPS_TILE_URL`; sin variable se usa la URL estándar anterior. Cualquier cambio futuro de fuente exige revisar licencia, atribución y CSP.

## Estado

La autorización de uso limitado de OSM consta en la solicitud de esta tarea. La activación operativa en Staging requiere publicar el artefacto Web y la configuración Nginx actualizada mediante el procedimiento autorizado; esta tarea no accede a AWS ni despliega.

## Validación local

En Chromium visible se cargó el build Web servido con la configuración Nginx de Staging en un contenedor local. Doce teselas de `tile.openstreetmap.org` respondieron HTTP 200 en escritorio; las solicitudes enviaron `Referer: http://localhost:3502/`. El navegador mostró calles y nombres en Guatemala, cuatro marcadores, recorrido, atribución enlazada y tabla, sin desbordamiento horizontal a 1366 ni 390 px. Las capturas locales `output/playwright/leaflet-publish-desktop.png` y `output/playwright/leaflet-publish-mobile.png` usan posiciones sintéticas y teselas externas reales; son evidencia local y no forman parte del código publicado. Las teselas respondieron con sus propias cabeceras de caché.

El zoom, el error HTTP 503 y el desmontaje al salir del viewport se probaron con las solicitudes de teselas interceptadas para no generar tráfico de prueba adicional hacia OSM. Zoom pasó del nivel 16 al 17, el error dejó visibles los cuatro marcadores y las cuatro filas, y fuera del viewport no quedaron teselas ni paneles Leaflet activos. Las pruebas Web (36), build, typecheck, contratos, escaneo de secretos y comprobación de sintaxis de Nginx pasaron. Lint terminó con 12 avisos preexistentes de API. La API Staging no se consultó: la compatibilidad se verificó mediante contratos y respuestas sintéticas en navegador; la integración real con ese entorno queda pendiente de una actualización Web autorizada.
