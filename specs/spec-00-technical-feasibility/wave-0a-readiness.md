# Puerta de entrada para Wave 0A independiente

**Evaluación documental: MAY_START_WITH_SCOPE_LIMITS.** OAuth e inventario de dispositivos pasaron en MSP Trial con arreglo vacío; el ID numérico procede de Customer Details. `GET /customers` sin `X-CUSTOMER` devolvió HTTP 302. Free y los dos teléfonos siguen pendientes. SPEC-00 sigue **BLOCKED**. Esta decisión no inicia la wave ni aprueba implementación en esta revisión. Wave 0A puede prepararse como trabajo fundacional independiente de la disponibilidad de la API ManageEngine Free, siempre que su especificación propia trace requisitos y acepte las puertas siguientes.

## Alcance que puede avanzar sin cerrar SPEC-00

- Definir el límite del adaptador MDM y estados de vínculo con implementaciones simuladas para contratos, sin asumir éxito de API ni inventario real.
- Especificar y, cuando se autorice la wave, construir esquema/servicios de identidad GEOPS, invitación de un uso, clave pública, sesión PoP, revocación y auditoría conforme a [ADR-012](../architecture/adr/ADR-012-identidad-dispositivo.md).
- Preparar contratos versionados, amenazas y pruebas negativas reproducibles con dispositivos sintéticos; los resultados de simulación no acreditan ManageEngine ni Android.
- Preparar infraestructura propia, CI, migraciones y observabilidad con datos ficticios, condicionada al inventario del servidor y normas de privacidad.
- Preparar runbooks y harness de prueba para [ManageEngine Free](mdm-free-api-validation.md) y [piloto](pilot-test-plan.md), sin guardar credenciales.

## Criterios de entrada

| ID | Condición verificable | Estado ahora |
| --- | --- | --- |
| W0A-E1 | Especificación propia de Wave 0A con alcance, tareas, contratos y criterios SDD trazados a PRD/ADR; exclusiones de funciones dependientes de MDM. | PENDING |
| W0A-E2 | ADR-012 y [contrato v1 de identidad](identity-api-contract.md) revisados por responsable técnico/seguridad; valores iniciales y casos negativos acordados. | DOCUMENTED, REVIEW_PENDING |
| W0A-E3 | Adaptador MDM desacoplado; pruebas de desarrollo usan fake y nunca convierten fake/Trial en PASS Free. | DESIGN_DECIDED |
| W0A-E4 | No se usa información real de empleados/dispositivos ni secretos hasta aviso, retención y entorno seguro aprobados. | PENDING |
| W0A-E5 | Se asigna responsable y ventana de prueba de cuenta Free y dos teléfonos, con registro de evidencia. | PENDING |

La **evaluación** permite planificar Wave 0A ahora. Para comenzar su implementación se necesitan W0A-E1/E2 y autorización de inicio de wave según el proceso SDD del proyecto. Las tareas puramente documentales no dependen de M01–M09. Si la implementación exige vinculación MDM real, instalación obligatoria, políticas Android o datos GPS, esa tarea espera los resultados correspondientes.

## Lo que sigue bloqueado

- Cierre de SPEC-00 y promesa de RF-01/RF-02 por API: M01–M09 en **Free** sin ejecutar.
- Activación operativa de teléfonos y selección de canal MDM: M08 y A01–A06 sin ejecutar.
- Piloto GPS de dos teléfonos: modelos, permisos, reinicio, cadencia, cifrado Room y umbrales pendientes.
- Expansión a 25 equipos o uso de datos reales: pruebas físicas, privacidad y capacidad pendientes.

**Regla:** un resultado PASS de pruebas unitarias/fakes solo cumple el contrato de Wave 0A; no cambia el estado BLOCKED de SPEC-00 ni reemplaza evidencia de proveedor/hardware.
