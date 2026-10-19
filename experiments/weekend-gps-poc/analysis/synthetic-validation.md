# Evidencia de validación sintética local

Comando: `node --test --test-isolation=none analysis/analysis.test.mjs`, ejecutado desde `experiments/weekend-gps-poc` el 2026-10-19. Resultado: **9/9 pruebas aprobadas**; ninguna consulta remota ni dato GPS real.

Se comprobó el contrato de columnas contra `api/schema.sql`; sesiones separadas por más de diez minutos y exclusión de esa pausa de la cadencia; igualdad exacta al umbral y aislamiento entre dispositivos; captura continua con recepción tardía; pausa larga dentro de una sesión; coordenadas repetidas con tiempos distintos y duplicados exactos; salto geográfico excluido de distancia; inversión de orden de recepción y latencia negativa; incertidumbre por precisión y muestreo escaso; y lectura/escritura CSV más validación estricta de período UTC. La concordancia con el esquema **desplegado** se verificará únicamente al ejecutar la extracción autorizada.
