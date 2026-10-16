# Riesgos y mitigaciones

**Escala:** probabilidad P e impacto I de 1 (bajo) a 3 (alto); prioridad = P×I. Son estimaciones cualitativas para ordenar validación, no resultados medidos. Dependencias en [open-questions.md](open-questions.md); pruebas en [pilot-test-plan.md](pilot-test-plan.md).

| ID | Riesgo / evidencia | P×I | Mitigación y puerta |
| --- | --- | --- | --- |
| RSK-01 | API ManageEngine documentada, pero derecho de uso y scopes en Free sin confirmar; RF-01/RF-02 podrían requerir licencia o proceso alterno. [R02–R03](research.md) | 3×3=9 | Probar OAuth y GET devices en tenant Free tras trial; registrar respuesta y condiciones. Si falla, decidir licencia o cambio aprobado de alcance. **Bloquea READY documental.** |
| RSK-02 | Inicio del Location FGS al turno/tras reboot puede fallar por restricciones Android/OEM; 60 s no garantizados. [R07–R09](research.md) | 3×3=9 | Prototipo en dos modelos/versiones, matriz de pantalla bloqueada, ahorro, reboot y permisos. Si falla, ajustar expectativa/flujo con aprobación. |
| RSK-03 | Room no cifra solo; pérdida del teléfono o backup automático puede exponer buffer GPS. [R10, R15](research.md) | 2×3=6 | Seleccionar cifrado de base/archivo, Keystore, exclusiones backup, borrado y recuperación; probar antes de datos reales. |
| RSK-04 | Protocolo de identidad decidido, pero entrega MDM y confirmación física no probadas; invitación filtrada o falso vínculo podrían causar suplantación/denegación. | 2×3=6 | [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md): invitación un uso, clave Keystore, PoP, código físico, revocación por llamada. Ejecutar M08/M09 y A01–A06; aprobar riesgo del modo manual. **Bloquea READY operativo**, no la decisión documental. |
| RSK-05 | Falta de precisión/continuidad GPS podría producir falsos verificados o falsos vencidos. [PRD RN-02–RN-04](../prd/GEOPS-PRD-v1.1.md) | 3×3=9 | Reglas conservadoras, estado no verificable, pruebas con pines reales, revisión de radios/permanencia. |
| RSK-06 | Retención de 90 días sin política de backup/derivados podría conservar ubicación más tiempo. | 2×3=6 | Definir plazo legal y técnico de backups, purga, restauración y minimización antes de producción. |
| RSK-07 | 25 equipos consumen todo el cupo Free; reemplazos o dispositivos de prueba podrían exigir licencias. [R02](research.md) | 2×2=4 | Registrar alta/baja y reservar margen operativo o presupuesto; verificar cómo cuenta ManageEngine equipos retirados. |
| RSK-08 | Uso masivo de Overpass/teselas OSM públicas puede ser bloqueado y incumplir políticas. [R11–R12](research.md) | 2×2=4 | Adaptador de fuente, consultas moderadas, caché y proveedor de teselas de producción; atribución/licencia. |
| RSK-09 | Importación de catálogo sin esquema/autoridad de cédula puede mezclar clientes y prospectos erróneamente. | 2×2=4 | Obtener muestra autorizada, validación de columnas, procedencia, revisión humana y deduplicación. |
| RSK-10 | Servidor cloud compartido puede carecer de aislamiento/capacidad/backup independiente. | 2×3=6 | Auditar CPU, RAM, IOPS, redes, secretos, dominio y restauración; medir 1,62 M posiciones/90 días más WAL/backups. |
| RSK-11 | Sin aviso/criterios legales de seguimiento laboral puede invalidar el piloto con datos reales. | 2×3=6 | Revisión de privacidad y normativa aplicable en Costa Rica, información a empleados, roles y retención. |
| RSK-12 | Reenvío masivo tras desconexión o worker atrasado puede elevar latencia y duplicar visitas. | 2×2=4 | Lotes/rate adaptativos, índice único de evento, outbox y worker idempotente; probar backlog de 7 días. |

Ningún riesgo se considera cerrado por lectura documental. RSK-01 mantiene bloqueo de API Free; RSK-04 conserva riesgo de integración/operación pese a la decisión de protocolo. RSK-02, RSK-03 y RSK-05 requieren evidencia de piloto y umbrales aprobados antes de prometer viabilidad.
