# GEOPS Web — migración a Leaflet y auditoría del mapa

**Fecha:** 20/10/2026 · **Rama:** `codex/spec-02-wave-1` · **HEAD inicial y final:** `c27f656c71a82eee31e2bf281bb98eaf473be067` · Sin commit, push, merge ni despliegue.

## Alcance y causa

Se aplicó la decisión de usar Leaflet como único motor cartográfico de GEOPS Web. Se eliminó `maplibre-gl`, su worker, CSS e inicialización. Se añadieron `leaflet@1.9.4` y `@types/leaflet@1.9.21` en `apps/web/package.json` y `package-lock.json`; `npm ls` confirma que MapLibre ya no es dependencia activa. Vite no tenía configuración exclusiva de MapLibre y no requirió cambios.

Se conservaron los contratos y el transporte de API: autorización `gps.location.read`, sesión y tenant se resuelven en servidor; cada consulta de ubicaciones lleva motivo de acceso, y no se enviaron coordenadas a terceros. No se modificó la PoC.

Archivos de la migración: `apps/web/src/gps/GpsMap.tsx`, `GpsDeviceWorkspace.tsx`, `map-model.ts`, `tracking-model.test.ts`, `gps.css`, `apps/web/package.json`, `package-lock.json`, `docs/development/gps-map-wave-1.md` y este informe. La auditoría histórica recibió solo una nota de actualización.

## Reutilización y comportamiento

La implementación original de `experiments/weekend-gps-poc/web/main.jsx` aportó los patrones `L.map`, `tileLayer`, `layerGroup`, `polyline`, `circleMarker`, `fitBounds`, `invalidateSize` y `remove`. La versión Web los adapta a React, desmonta el mapa y `ResizeObserver`, y usa imports diferidos. No se copiaron la autenticación, los endpoints ni la URL pública de teselas de la PoC.

`GpsMap.tsx` muestra posiciones, la última en color distinto, círculo de precisión de la selección, recorridos por segmento, controles táctiles de zoom y ventanas con captura, recepción y precisión. Los segmentos se cortan al cambiar de sesión o al superar cinco minutos sin captura. Los marcadores se seleccionan por puntero o Enter/Espacio y conservan el foco tras redibujarse. `GpsDeviceWorkspace.tsx` conserva nombres de dispositivos, filtros rápidos, sesión, zona horaria, antigüedad y tabla accesible; el mapa ocupa la zona principal y las opciones detalladas están inmediatamente debajo. La selección de dispositivo o período limpia datos anteriores antes de consultar. En vacío, error de API, fallo de teselas o desconexión, la tabla y los mensajes siguen siendo la vía de consulta.

## Teselas y Staging

La PoC usa el servicio público OSM. **No se activó para Staging.** [OSMF indica](https://operations.osmfoundation.org/policies/tiles/) que la capacidad es limitada, no hay SLA, se requiere atribución y caché, y el acceso puede retirarse; sus solicitudes también revelan el área vista. Leaflet tiene [licencia BSD de dos cláusulas](https://github.com/Leaflet/Leaflet/blob/main/FAQ.md), distinta de los términos de cada proveedor de teselas. GEOPS requiere una fuente ráster PNG/WebP aprobada y servida desde el mismo origen, con licencia, atribución, privacidad, capacidad y redirecciones revisadas. Se configura al compilar Web con `VITE_GPS_TILE_URL=/maps/tiles/{z}/{x}/{y}.png`. Sin esta variable, los puntos se dibujan sobre fondo neutro y se muestra “Mapa sin calles”. **Las calles todavía no están habilitadas.** Véase [decisión y procedimiento](gps-map-wave-1.md).

## Impeccable y UIAudit

El lanzador standalone de Impeccable inicialmente falló al crear caché fuera del workspace. Se recuperó `IMPECCABLE_BIN` del entorno User de Windows y se fijó `IMPECCABLE_HOME` dentro del workspace. `impeccable.cmd context --target apps/web/src/gps/GpsDeviceWorkspace.tsx` respondió correctamente y confirmó que no existen PRODUCT.md ni DESIGN.md; se conservó el sistema visual CSS existente. `impeccable.cmd detect --json` sobre `GpsMap.tsx`, `GpsDeviceWorkspace.tsx` y `gps.css` devolvió `[]`. Ese resultado solo significa que no emitió hallazgos mecánicos; no demuestra ausencia de problemas. La auditoría complementaria UIAudit se ejecutó con su copia empaquetada del motor y el mismo `detect --json`; también devolvió `[]`. Se leyó y aplicó el flujo `audit` de UIAudit y se revisaron manualmente accesibilidad, rendimiento, responsive, temas e integridad.

| Dimensión UIAudit | Puntuación provisional /4 | Evidencia y límite |
| --- | ---: | --- |
| Accesibilidad | 3 | Regiones con nombre, foco visible, marcadores por teclado y tabla equivalente. Sin prueba de lector de pantalla. |
| Rendimiento | 3 | Leaflet diferido, capa limpiada y un solo mapa tras remontaje. No se perfiló un volumen masivo de posiciones. |
| Responsive | 3 | 390, 768, 1024 y 1366 px sin desbordamiento horizontal; a 390 px el mapa comienza hacia el final del primer viewport. Reflujo a 640 CSS px como equivalente de 200 % en 1280 px; no se automatizó el zoom nativo del navegador. |
| Temas | 2 | Consistente con GEOPS claro, pero colores cartográficos aún son valores locales y no hay variante oscura específica. |
| Integridad | 4 | Copy basado en estado real, fuente no aprobada declarada, API y tabla coherentes, sin segundo motor. |
| **Total** | **15/20** | **Bueno, con límites de verificación explícitos.** |

Hallazgos corregidos durante la revisión: [P1] aviso de teselas superpuesto a marcadores, movido bajo el mapa; [P2] mapa demasiado bajo en móvil, filtros rápidos compactados y mapa adelantado; [P2] pérdida de foco al redibujar un marcador, restauración implementada. Pendientes: [P1] aprobar y operar una fuente de teselas para mostrar calles en Staging; [P2] validar lector de pantalla y zoom nativo de 200 % en entorno objetivo; [P2] comprobar con datos reales el rendimiento de períodos con muchos puntos.

## Capturas comparativas

La captura inicial aportada por el usuario muestra la pantalla anterior a Wave 1, sin calles ni mapa. Las capturas finales son del navegador local con datos sintéticos y **sin fuente de teselas**; muestran puntos y recorridos, no calles.

- [Inicial aportada por el usuario](../../output/playwright/gps-before-user-capture.png)
- [Leaflet escritorio, 1366 px](../../output/playwright/leaflet-desktop-1366-full.png)
- [Leaflet móvil, 390 px](../../output/playwright/leaflet-mobile-390-full.png)

## Verificación

- `npm test`: pasó Web (36), API/Node, contratos y suites de migración/restauración.
- `npm run typecheck`, `npm run build`, `npm run contracts:check`, `npm run security:scan`, `git diff --check`: pasaron.
- `npm run lint`: pasó con 12 advertencias preexistentes fuera de los archivos Leaflet.
- Navegador con API sintética: cuatro posiciones, hueco temporal y cambio de sesión, precisión baja, selección por teclado, filtros, cambio de dispositivo a vacío, 401/403, ruta sin teselas, fallo de teselas, sin conexión y montaje/desmontaje. En 390/768/1024/1366 px el ancho del documento coincidió con el viewport. En reflujo a 640 CSS px tampoco hubo desbordamiento.
- La URL de teselas de prueba `/maps/tiles/{z}/{x}/{y}.png` produjo error controlado, con 4 marcadores y 4 filas todavía visibles. Esta prueba **no** valida una fuente aprobada ni la cartografía de calles.

La compatibilidad de Web con API Staging queda respaldada por contratos, transporte y mocks sintéticos. No se consultó ni desplegó Staging/AWS; falta una comprobación end to end allí con la fuente aprobada. Para actualizar solo Web, seguir el [procedimiento](gps-map-wave-1.md#actualizar-solo-web). Los cambios locales previos de Android y API permanecieron intactos por esta migración.

## Actualización del cierre de teselas

La decisión posterior del usuario seleccionó [OpenStreetMap para el piloto](leaflet-osm-pilot-2026-10-20.md), usando la misma URL de la PoC. La atribución OSM se mantiene visible y el mapa no pide teselas antes de entrar al viewport ni cuando no hay posiciones. La configuración Web de Staging anterior bloqueaba imágenes externas y eliminaba el `Referer`; la corrección de Nginx está preparada y validada localmente. Las calles no estarán disponibles en Staging hasta publicar tanto Web como esa configuración mediante un despliegue autorizado. Se conserva este informe como registro de la migración original.
