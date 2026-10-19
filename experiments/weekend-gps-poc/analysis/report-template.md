# GEOPS — Informe del experimento GPS de fin de semana

**Estado:** pendiente de extracción autorizada. **Período UTC:** [inicio inclusivo, fin exclusivo]. **Operador/revisión:** [alias]. **Fuente:** `geops-weekend-poc/geops_poc`.

## Evidencia de origen

- Esquema vivo validado: [sí/no; fecha UTC]. Retención configurada: [horas, sin copiar otros valores de entorno]. Conteo extraído: [n]. Dispositivos seudonimizados: [n].
- Evidencia adicional del teléfono: [inicio/detención, permisos, cobertura GPS, red, cola local, batería, versión APK].
- Cobertura del período: [completa/parcial/desconocida]. Registrar si pudo actuar la retención.

## Por sesión candidata

| Sesión | Límite real o inferido | UTC inicio-fin | Puntos | Intervalo mediana/p95/máx | Dentro 60 ± 15 s | Precisión p95 | Latencia p95 | Tardías | Duplicados de coordenada y hora | Orden inverso | Saltos | Distancia estimada |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [seudónimo] | inferido | [UTC] | [n] | [s] | [n/N (%)] | [m] | [s] | [n] | [n] | [n] | [n] | [m] |

## Agregado

[Usar `analysis.json`: total de posiciones, sesiones, duración observada sumada, distribución de intervalos **intra-sesión**, precisión, latencia, pausas y tramos. No incluir pausas entre sesiones.]

## Qué funcionó / qué falló

[Separar persistencia demostrada de comportamiento del dispositivo documentado por otras evidencias.]

## Resultados demostrados / inferidos / faltantes

- **Demostrados:** [filas efectivamente persistidas, tiempos, precisión, recepción].
- **Inferidos:** [sesiones, tipos de tramo, distancia, posible salto].
- **Faltantes:** [inicios/detenciones persistidos, reintentos de lote, fixes rechazados/no recibidos, estado de red y batería, datos purgados].

## Objetivo de 60 segundos

[Porcentaje y tamaño de muestra por sesión, cobertura conocida, sesiones con un solo punto, tolerancia 15 s. No declarar validación con cobertura insuficiente o desconocida.]

## Riesgos de 1 a 25 dispositivos y recomendaciones

[Capacidad DB/API, almacenamiento y backups, colas offline, índices/retención, privacidad y controles de acceso. La PoC actual permite un dispositivo. Priorizar eventos persistidos de sesión y diagnósticos, observabilidad de sincronización y prueba sintética de carga antes de escalar.]

## Privacidad y disposición

[Quién tuvo acceso, ubicación privada del extracto, fecha de eliminación autorizada, tratamiento de backups. No adjuntar coordenadas al repositorio.]
