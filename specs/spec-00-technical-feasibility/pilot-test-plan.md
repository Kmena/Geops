# Plan de piloto con dos teléfonos reales

**Estado:** plan, sin ejecución. Ninguna prueba tiene resultado PASS o FAIL. Ambas columnas de resultado deben permanecer `PENDING_PHYSICAL_VALIDATION` hasta ejecutar cada caso; luego registrar **PASS / FAIL / BLOCKED**, fecha, versión Android/app/MDM, red, batería y evidencia. Si una prueba requiere backend/agente aún inexistente, anotar BLOCKED por implementación al momento de la ejecución, sin inferir comportamiento. Fuente: [PRD CA-01–CA-12, VAL-01–VAL-08](../prd/GEOPS-PRD-v1.1.md).

**Teléfonos:** A y B por identificar (marca/modelo/Android/Play Services en [Q-01](open-questions.md)). Elegir, si es posible, OEM/versiones diferentes. Usar datos y cuentas de prueba autorizados, sin empleados reales antes de avisos y revisión de privacidad. Guardar capturas de consola y logs con secretos, identificadores personales y coordenadas sensibles redactados.

## Preparación

1. Registrar edición y región ManageEngine; verificar si el tenant sigue Free después del Trial y probar scopes de API sin exponer tokens. Registrar procedimiento de recuperación y reset.
2. Definir horario de prueba, zona IANA, pin de prueba, radio, permanencia, objetivo de cadencia y presupuesto de batería **antes** de medir. Los umbrales cuantitativos faltan en Q-06–Q-09; no declarar PASS de esos casos sin aprobación.
3. Sincronizar hora de ambos equipos; anotar versión de Android, parche, estado de ahorro, permisos, red, carga y firmware. Preparar red con y sin Internet y ubicaciones interiores/exteriores.
4. Crear identificadores de eventos y exportar métricas de captura/ACK para comparar sin depender del orden de llegada. La API conserva captura y recepción por separado.

## Matriz de prueba

| ID | Prueba en A y B / procedimiento | Evidencia esperada | Condición de aceptación | A / B actual |
| --- | --- | --- | --- | --- |
| P01 | Restablecer y enrolar mediante QR **Admin Fully Managed**; comprobar modo. | Captura MDM, estado Device Owner, modelo/OS. | Ambos inscritos en Fully Managed; no Work Profile por error. | PENDING / PENDING |
| P02 | Distribuir agente privado de prueba como obligatorio y actualizarlo. | Versión antes/después, asignación y estado en MDM. | Instalación/actualización conforme a política sin intervención no prevista. | PENDING / PENDING |
| P03 | Intentar desinstalación ordinaria y verificar visibilidad/avisos. | Video/capturas de intento, launcher y notificación de ubicación. | Desinstalación bloqueada según política; indicadores obligatorios visibles. | PENDING / PENDING |
| P04 | Aplicar restricción Location Services y permisos; intentar cambio por usuario. | Perfil MDM, ajustes antes/después, aviso Android. | Política compatible se aplica; fallos/OEM documentados. No suprimir avisos. | PENDING / PENDING |
| P05 | Jornada de 8–12 h con pantalla bloqueada, movimiento y quietud; solicitar 60 s. | Serie `captured_at`, precisión, huecos, batería, estado de pantalla. | Objetivo medido frente a umbrales **por aprobar** Q-06; no exigir garantía inexistente. | PENDING / PENDING |
| P06 | Inicio, cambio y fin de horario; incluir excepción y cruce de medianoche. | Eventos antes/durante/después, versión de horario, logs del servicio. | Sin nueva captura fuera de horario autorizado; inicio automático solo si se verifica. | PENDING / PENDING |
| P07 | Cortar Internet manteniendo ubicación disponible durante varias horas. | Conteo e IDs en Room, `captured_at`, estado de red. | Eventos disponibles persistidos una vez, sin inventar posiciones. | PENDING / PENDING |
| P08 | Obstruir GNSS con Internet activo y, aparte, desactivar Location Services según política. | Heartbeats/diagnóstico, fuente y precisión de fixes fusionados, intervalos sin fix. | No se repite última coordenada como nueva; si FLP entrega fix por otra fuente, se evalúa su calidad. | PENDING / PENDING |
| P09 | Restablecer Internet; forzar timeout de ACK y reenviar mismo lote. | IDs locales, respuestas accepted/duplicate, conteo SQL. | Persistencia única por evento, orden por captura y ACK tras COMMIT. | PENDING / PENDING |
| P10 | Reiniciar durante y fuera de turno, con/sin red y con batería baja. | Logs boot, permisos, servicio, WorkManager, primer evento/ACK. | Reanuda por vía permitida, sin captura fuera de turno ni pérdida del buffer; limitaciones registradas. | PENDING / PENDING |
| P11 | Repetir P05 con ahorro de batería/Doze y comparar drenaje. | Batería inicial/final, corriente si disponible, eventos, políticas OEM. | Cumple presupuesto **por aprobar** Q-06; se reporta degradación de cadencia. | PENDING / PENDING |
| P12 | Dejar de enviar heartbeat durante turno y luego reconectar. | Alerta, umbral, última ubicación con antigüedad, cierre. | Causa “desconocida” mientras no haya evidencia; no afirmar apagado. | PENDING / PENDING |
| P13 | Visitar/no visitar pin recurrente con datos buenos, ausentes y tardíos. | Regla versionada, posiciones, estado antes/después, auditoría. | Verificado solo con evidencia; vencido o no verificable según cobertura; recálculo auditado. | PENDING / PENDING |
| P14 | Pasar cerca del borde del radio con GPS preciso e impreciso. | Distancia, `accuracy_m`, permanencia y decisiones. | No confirmar visita ambigua; calibrar radio/precisión aprobados Q-07. | PENDING / PENDING |
| P15 | Reasignar dispositivo y cambiar ruta/horario mientras hay backlog. | Versiones efectivas, recepción tardía y visitas atribuidas. | Pasado asociado a versiones válidas en captura; sin duplicar obligación. | PENDING / PENDING |
| P16 | Verificar API MDM en tenant Free después de Trial según M01–M09. | Edición, scope OAuth, GET devices/details y códigos redactados. | RF-01/RF-02 factibles o alternativa/licencia aprobada. | PENDING / PENDING |
| P17 | Inscribir con invitación individual, challenge, clave Keystore y confirmación física. | Auditoría y key_id distintos; referencia a attestation si disponible. | A01, A02 y A06; sin activación por solo QR/UDID. | PENDING / PENDING |
| P18 | Intentar replay/claim concurrente, token sin firma, cuerpo alterado y nonce repetido. | HTTP/razón redactados, ausencia de sesión/ingesta. | A02–A03; ningún impostor activo. | PENDING / PENDING |
| P19 | Renovar sesión, rotar clave y revocar durante sesión válida. | Estados de claves/sesiones, siguiente llamada rechazada. | A03–A04; revocación efectiva inmediatamente. | PENDING / PENDING |
| P20 | Simular pérdida, reinstalación y reasignación con datos ficticios. | Nueva invitación, vínculo MDM y asignaciones con vigencia. | A05; historial separado y acceso antiguo inválido. | PENDING / PENDING |

## Ejecución y evaluación

En cada caso: guardar procedimiento exacto, configuración, hora inicio/fin, evidencias y discrepancias. **PASS** requiere cumplir condición y umbrales aprobados en ambos teléfonos cuando aplique. **FAIL** significa que se ejecutó y no cumplió. **BLOCKED** significa que no pudo ejecutarse por cuenta, permisos, hardware o implementación; registrar causa y siguiente acción. `PENDING_PHYSICAL_VALIDATION` significa no ejecutada.

Puerta mínima antes de ampliar de 2 a 25: P01–P04, P06–P10 y P16–P20 deben tener resultado aceptable o cambio de alcance aprobado; P05/P11/P13/P14 necesitan umbrales y comportamiento calibrados; P12/P15 requieren backend operativo. Cualquier captura fuera de horario o fuga de datos bloquea el piloto con datos reales. La expansión requiere además revisar privacidad, capacidad y soporte de dispositivos. [wave-readiness.md](wave-readiness.md)
