# SPEC-00 — Informe de cierre documental

**Fecha de corte:** 2026-10-16. **Estado global: BLOCKED.** La investigación y arquitectura tienen un corte documental para planificar trabajo posterior. Viabilidad operativa, autorización de implementación y autorización de producción son decisiones separadas. Este informe no ejecuta Archive en el ciclo SDD ni modifica los criterios de [wave-readiness.md](wave-readiness.md).

## 1. Resumen ejecutivo

El [PRD v1.1](../prd/GEOPS-PRD-v1.1.md) quedó trazado a requisitos, riesgos, contratos propuestos, ADR y un plan de piloto. OAuth y la lectura de inventario funcionaron en **ManageEngine MSP Cloud Trial**, con cero dispositivos inscritos. La edición **Free**, las políticas MDM y el comportamiento de dos Android reales no están validados. El diseño de identidad individual fue aceptado como decisión arquitectónica en ADR-012; su implementación, revisión de seguridad y vínculo físico con MDM siguen pendientes.

**Dictamen:** investigación documental completada para este corte; SPEC-00 conserva **BLOCKED** como estado de viabilidad. SPEC-01/Wave 0A puede especificarse con alcance independiente y puertas explícitas. Este informe no autoriza implementar una wave ni desplegar producción.

## 2. Alcance documental completado

- PRD trazado en [requirements.md](requirements.md), con parámetros abiertos identificados.
- Investigación, arquitectura, modelo de datos, contratos, reglas, riesgos y preguntas en el [índice de SPEC-00](README.md).
- ADR-001–006: decisiones iniciales; ADR-007–010: propuestas condicionadas; ADR-011: IA diferida; [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md): protocolo de identidad aceptado como diseño, sujeto a revisión e integración.
- Matrices reproducibles [M01–M10](mdm-free-api-validation.md) y [P01–P20](pilot-test-plan.md), y [puerta de Wave 0A](wave-0a-readiness.md).

## 3. Evidencias y procedencia

| Evidencia | Resultado y límite | Procedencia |
| --- | --- | --- |
| MSP Cloud Trial, Android Enterprise vinculado, organización GEOPS configurada y DEFAULT_CUSTOMER existente | Configuración comunicada por el usuario; no demuestra políticas ni capacidades Free. | Confirmación del usuario y [matriz MDM](mdm-free-api-validation.md). |
| OAuth de inventario | Intercambio de código HTTP 200 con scope de lectura de inventario, solo Trial. | M02, ejecución local sanitizada. |
| Inventario MSP | GET /api/v1/mdm/devices HTTP 200 con X-CUSTOMER y arreglo devices vacío; cero dispositivos inscritos. No demuestra detalle, paginación efectiva ni vínculo nombre–ID por API. | M03; ID obtenido por el usuario de Customer Details, fuera de documentos versionables. |
| Revocación | Dos refresh tokens revocados con HTTP 200 y dos renovaciones posteriores rechazadas, solo Trial. | M10, ejecución local sanitizada. |
| Pruebas automatizadas | 18/18 PASS con respuestas simuladas; no prueban proveedor ni hardware. | [Diagnóstico OAuth](../../docs/development/mdm-oauth-local.md). |
| Identidad por dispositivo | Invitación de un uso, clave Keystore, prueba de posesión, revocación y reasignación documentadas. | [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md) y [contrato v1](identity-api-contract.md). |

No se publican identificadores internos, credenciales, códigos ni tokens. GET /customers sin X-CUSTOMER respondió HTTP 302; no se atribuye a esa ruta el descubrimiento del cliente.

## 4. Decisiones arquitectónicas

1. Agente Kotlin propio para GPS; MDM para administración y distribución. Políticas efectivas pendientes de piloto ([ADR-002](../architecture/adr/ADR-002-gps-propio.md), [ADR-007](../architecture/adr/ADR-007-mdm-externo.md)).
2. Identidad GEOPS individual por dispositivo con clave Keystore y verificación independiente del vínculo MDM; diseño aceptado, sin implementación ([ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md)).
3. Ingesta por lotes idempotente y buffer local persistente; cifrado concreto, reinicios y límites pendientes ([ADR-003](../architecture/adr/ADR-003-ingesta-gps.md), [ADR-008](../architecture/adr/ADR-008-buffer-offline.md)).
4. PostgreSQL/PostGIS y procesamiento desacoplado de visitas son propuestas a medir; IA de rutas fuera de etapa 1 ([ADR-009](../architecture/adr/ADR-009-datos-geoespaciales.md), [ADR-010](../architecture/adr/ADR-010-visitas-recurrentes.md), [ADR-011](../architecture/adr/ADR-011-ia-rutas-diferida.md)).

## 5. Matriz de validaciones pendientes

La clasificación señala la próxima evidencia necesaria, no un resultado. Los responsables son **roles propuestos**, aún sin persona asignada. La wave es destino de planificación, no autorización de implementación.

| Validación | Clasificación | Responsable por rol | Wave | Evidencia pendiente |
| --- | --- | --- | --- | --- |
| API disponible en Free | PENDING_MDM_FREE_VALIDATION | Integración MDM | 0B | Repetir M01–M09 en Free real. |
| API de lectura y modificación de perfiles | PENDING_MDM_FREE_VALIDATION | Integración MDM | 0B | Documentar scopes mínimos y probar lectura; modificación solo en plan autorizado posterior. |
| Instalación obligatoria de APK | PENDING_PHYSICAL_VALIDATION | Android / MDM | 0B | P02 en ambos teléfonos. |
| Restricción de desinstalación | PENDING_PHYSICAL_VALIDATION | Android / MDM | 0B | P03 en ambos modelos/versiones. |
| Restricción de ubicación | PENDING_PHYSICAL_VALIDATION | Android / MDM | 0B | P04 y avisos del sistema. |
| Vínculo identidad GEOPS–MDM | PENDING_PHYSICAL_VALIDATION | Seguridad / Android / MDM | 0B–1 | P17–P20 y verificación independiente. |
| Captura GPS cada minuto | PENDING_PHYSICAL_VALIDATION | Android / QA | 1 y 6 | P05 con umbrales aprobados. |
| Horarios laborales | PENDING_IMPLEMENTATION | Android / producto | 1 | Implementar contrato y luego P06. |
| Buffer offline | PENDING_IMPLEMENTATION | Android / API | 1–2 | Persistencia, cifrado, ACK e idempotencia; luego P07/P09. |
| Recuperación tras reinicio | PENDING_PHYSICAL_VALIDATION | Android / QA | 1 y 6 | P10 después de implementación. |
| Consumo de batería | PENDING_PHYSICAL_VALIDATION | Android / QA | 1 y 6 | P05/P11 y presupuesto aprobado. |
| Precisión de geocercas | PENDING_PHYSICAL_VALIDATION | Producto / QA geoespacial | 4 y 6 | P13/P14 con radio, precisión y permanencia aprobados. |
| Piloto con dos dispositivos reales | PENDING_PHYSICAL_VALIDATION | QA / MDM | 0B y 6 | Modelos/versiones y P01–P20 por equipo. |

**Bloqueo transversal:** RF-01/RF-02 y el cierre operativo de SPEC-00 permanecen BLOCKED hasta validar Free o aprobar formalmente una alternativa. Ninguna prueba física tiene PASS.

## 6. Riesgos aceptados provisionalmente

Solo para continuar la **especificación** se acepta que Trial pueda diferir de Free, que cero dispositivos impidan validar detalle/paginación y que las políticas y cadencia Android varíen por modelo. [risks.md](risks.md) conserva mitigaciones. No se acepta este riesgo para producción, datos reales ni promesas RF-01/RF-02. Producto deberá decidir alternativa/licencia si Free falla; seguridad y privacidad revisarán aviso, acceso y retención.

## 7. Dependencias trasladadas a waves

| Wave | Dependencia |
| --- | --- |
| 0A | Especificación propia, revisión ADR-012/contrato, adaptador MDM simulado y puertas W0A-E1–E5. |
| 0B | Free real, perfiles/políticas MDM, instalación y restricciones, vínculo con dos teléfonos. |
| 1 | Agente, horarios, captura, buffer, reinicio y batería. |
| 2 | Ingesta, historial y alertas; idempotencia y desconexión. |
| 3 | Captación e importación; fuentes y esquema reales por validar. |
| 4 | Rutas, recurrencias y geocercas con umbrales aprobados. |
| 5 | Dashboard/reportes con reglas y cifras reconciliables. |
| 6 | Integración, aceptación física, privacidad y despliegue progresivo. |

## 8. Criterios de entrada de SPEC-01

SPEC-01 puede **iniciarse como trabajo de especificación** si declara su alcance Wave 0A, traza historias/tareas a PRD/ADR/aceptación, separa trabajo fundacional de dependencias MDM Free y físicas, incluye responsables por rol y evidencia esperada, y conserva [W0A-E1–E5](wave-0a-readiness.md). La autorización posterior de implementación exige revisión técnica y de seguridad y cumplir las puertas aplicables de Wave 0A. Iniciar SPEC-01 no vuelve READY a SPEC-00.

## 9. Estados independientes

| Dimensión | Estado al corte |
| --- | --- |
| Investigación y arquitectura documental | COMPLETED para este corte, con preguntas trazadas. |
| SPEC-00 / viabilidad operativa | BLOCKED; conserva criterios originales. |
| M02/M03/M10 en Trial | PASS limitado; M01 y M04–M09 PENDING. |
| Wave 0A | MAY_START_WITH_SCOPE_LIMITS para planificación; implementación pendiente. |
| Autorización de implementación | NOT_GRANTED por este informe. |
| Autorización de producción | NOT_GRANTED; exige aceptación, seguridad, privacidad y pruebas reales. |

## 10. Recomendación de continuidad

Abrir SPEC-01 para concretar Wave 0A y asignar responsables/ventanas a Free y piloto. Mantener SPEC-00 BLOCKED hasta cumplir [sus criterios vigentes](wave-readiness.md); registrar nueva evidencia en M01–M10 y P01–P20 sin trasladar PASS de Trial a Free.
