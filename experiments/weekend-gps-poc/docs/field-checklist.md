# Checklist físico y métricas — un teléfono autorizado

**Estado global: PENDING_PHYSICAL_VALIDATION.** El operador informó HTTP 201 y dispositivo activo sin posiciones; también confirmó cero pendientes, cero capturas guardadas y ningún dato local que conservar. Autorizó reinstalación limpia y reinscripción del único teléfono. Repetir la comprobación de contadores inmediatamente antes de borrar datos. Registrar fecha, alias, Android/Play Services, red, hash de APK y evidencia sanitizada. Ningún caso de campo completo es PASS aún.

| ID | Prueba | Resultado |
| --- | --- | --- |
| F01 | Instalar APK aprobada y verificar firma/versión | PENDING |
| F02 | QR temporal, inscripción de un uso, inventario | HTTP 201 e inventario activo reportados; reutilización y credencial tras reinicio PENDING |
| F03 | Inicio manual, notificación visible y botón detener | PENDING |
| F04 | 15 min con pantalla activa y luego bloqueada; medir cadencia objetivo 60 s | PENDING |
| F05 | Cortar Internet manteniendo GPS; contar eventos en Room | PENDING |
| F06 | Recuperar Internet; ACK, reintento y cero duplicados en DB | PENDING |
| F07 | Sin señal GPS con Internet; no repetir última posición como nueva | PENDING |
| F08 | Reinicio del teléfono; no reiniciar captura, conservar buffer | PENDING |
| F09 | Revocar identidad; siguiente lote rechazado | PENDING |
| F10 | Detención manual, batería inicial/final, sesión de fin de semana | PENDING |
| F11 | Retención y borrado de DB, backups y datos locales en fecha aprobada | PENDING |

Métricas a registrar: capturas esperadas (duración/60 s), reales, intervalo medio/máximo, precisión promedio, duplicados, latencia de sincronización, duración sin red, batería inicial/final, tiempo de sesión y eventos descartados con motivo. El dashboard calcula algunas métricas de eventos recibidos; capturas esperadas, pérdida sin fix, batería y backlog requieren evidencia del teléfono. No inferirlos de la base.
