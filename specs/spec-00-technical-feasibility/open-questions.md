# Preguntas y decisiones abiertas

**Fecha:** 2026-10-16. Responder cada punto con decisión, responsable, evidencia y fecha; actualizar [requirements.md](requirements.md), [risks.md](risks.md) y el ADR pertinente. No se presupone que la respuesta exista en el PRD.

| ID | Pregunta / dependencia | Evidencia necesaria | Efecto |
| --- | --- | --- | --- |
| Q-01 | ¿Cuáles son marca/modelo, versión Android, Play Services, modo de batería y operador de los dos teléfonos? | Inventario físico de ambos. | Matriz de compatibilidad y piloto. |
| Q-02 | Resuelto: tenant MSP Cloud Trial, región `.com` (`mdm.manageengine.com`). OAuth de lectura pasó en Trial. `GET /customers` sin `X-CUSTOMER` respondió HTTP 302; ID numérico confirmado desde Customer Details; GET devices HTTP 200 con lista vacía en Trial. Pendiente: vínculo nombre↔ID por API, dos equipos y funcionamiento en Free. | Captura de edición, scopes, respuesta API y términos vigentes sin exponer secretos. | **Bloquea READY** para RF-01/RF-02. |
| Q-03 | **DECIDIDO en ADR-012:** invitación temporal de un uso, clave Keystore por equipo, PoP, activación física, rotación y revocación. | [Diseño completo](device-provisioning.md); A01–A06 siguen sin ejecutar. | Protocolo documental cerrado; integración/aceptación operativa queda en Q-19. |
| Q-04 | ¿Qué permiso de ubicación y flujo de inicio de turno/reinicio son compatibles con los teléfonos y política MDM? | Logs Android, estado de permisos, pruebas bloqueado/reboot. | Viabilidad de captura sin intervención diaria. |
| Q-05 | ¿Qué cifra local concreta protegerá Room, cómo se manejarán claves/backup y qué ocurre al reinstalar? | Decisión técnica y prueba con datos ficticios. | Privacidad y resiliencia. |
| Q-06 | ¿Qué porcentaje de capturas dentro de 60 s, precisión y consumo de batería será aceptable? | Criterios aprobados antes del piloto, mediciones por teléfono. | Puerta de RF-05. |
| Q-07 | ¿Cuáles son radio, precisión máxima, permanencia, hueco máximo entre muestras y cobertura mínima por pin? | Reglas de negocio aprobadas y pruebas de campo. | Visitas verificadas/no verificables. |
| Q-08 | ¿Cómo se anclan las frecuencias (semana, N días laborales), qué calendario/feriados aplica y cuándo vence exactamente? | Ejemplos con fechas, medianoche y excepciones. | Recurrencia y alertas. |
| Q-09 | ¿Umbral de heartbeat, horario de evaluación, escalamiento y cierre de alerta? | Política operativa aprobada. | Alertas de desconexión. |
| Q-10 | ¿Cómo se versionan cambios offline de horario/ruta y qué plazo de atraso se acepta para recalcular? | Escenarios aprobados y política late data. | Reconciliación y privacidad. |
| Q-11 | ¿Esquema, encoding, cédula y autoridad del CSV/XLSX comercial? | Muestra anonimizada autorizada y diccionario de datos. | Importación y clasificación. |
| Q-12 | ¿Territorios/categorías iniciales y proveedor de teselas apto para producción? | Muestra de consultas OSM, cobertura, términos/proveedor. | Captación y mapa. |
| Q-13 | ¿Capacidad, backups, TLS, dominio y aislamiento verificables del servidor compartido? | Inventario cloud y ensayo de restauración. | Despliegue migrable. |
| Q-14 | ¿Plazos de eliminación para backups, auditoría, visitas derivadas y exportaciones? | Política de privacidad y revisión legal en Costa Rica. | Retención coherente de 90 días. |
| Q-15 | ¿Qué proveedor de identidad, MFA y duración de sesión se usarán para administradores? | Política de acceso aprobada. | Seguridad web. |
| Q-16 | ¿Se acepta carga manual temporal de inventario si la API MDM no está disponible en Free, o se contratará licencia? | Decisión de producto tras Q-02. | Plan alterno para RF-01/RF-02. |
| Q-17 | ¿Cuál será la capacidad máxima del buffer local y la acción al agotarse? | Medición de almacenamiento y política de incidente. | Resiliencia offline. |
| Q-18 | ¿Cuándo queda congelado un reporte frente a ubicaciones tardías y cómo se comunica una corrección? | Regla de negocio y ejemplo. | Confianza del dashboard. |
| Q-19 | ¿Puede la cuenta Free entregar managed configuration individual y verificar por API el vínculo GEOPS↔MDM, o se aprobará la vía presencial manual auditada? | M08, M09 y A01–A06 en A/B; revisión de seguridad del procedimiento manual si aplica. | **Bloquea READY** de activación operativa, sin reabrir el protocolo Q-03. |

**Aclaraciones resueltas por PRD y solicitud:** agente GPS propio; MDM administra y no es canal primario de GPS; 2→25 dispositivos; una captura por minuto como objetivo; 90 días de posiciones; usuarios autorizados administradores; IA de rutas diferida a etapa 2; independencia de Inventori/Billing. Ninguna de estas aclaraciones implica que el comportamiento Android/MDM esté probado.
