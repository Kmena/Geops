# ADR-026 — Autorización GPS por propiedad del dispositivo

**Fecha:** 2026-11-02. **Estado:** V1 parcial; despliegue y validación física pendientes. Complementa ADR-020 y no cambia retroactivamente GPS v1/v2.

## Contexto

B32 separa asignaciones de ruta de políticas GPS, pero no persiste una clasificación de propiedad verificable para toda la flota. Una política continua MDM ya existe; BYOD usa el horario GPS ordinario. La consola aún ofrece parada MDM y no distingue propiedad. Las posiciones no exponían una clasificación histórica de ruta.

## Decisión

Persistir `CORPORATE_MANAGED`, `PERSONAL_BYOD` o `UNVERIFIED` con versión, fuente, vigencia y auditoría. Una configuración corporativa continua requiere evidencia MDM obtenida por backend y autorización administrativa vigente. Una BYOD requiere autorización personal y la ventana laboral de la política GPS; las ventanas de ruta nunca autorizan captura. `UNVERIFIED` cierra nuevas capturas. El cliente conserva la última autorización autenticada hasta su fin explícito y aplica revocaciones recibidas de inmediato. Captura, subida de cola y clasificación de rutas son funciones independientes.

La clasificación y activación se hacen por dispositivo mediante una mutación administrativa con versión previa, base documentada, referencia de evidencia, fecha del aviso de privacidad y vigencia. El enlace de inventario MDM no activa GPS. Ninguna migración reclasifica la flota existente. La activación corporativa espera un mapeo seguro entre el tenant operativo de GEOPS y el cliente ManageEngine; no se eliminan las comprobaciones de alcance para resolverlo.

La clasificación `EN_RUTA` se calcula por timestamp de captura contra vínculo agente–dispositivo y asignación histórica; de otro modo es `FUERA_DE_RUTA`. Se conserva la posición en ambos casos. La atribución de una visita sigue sus propias ventanas, geozonas y algoritmo B32.

## Consecuencias

Se requiere contrato versionado y migración aditiva para no permitir que una APK v9 interprete un modo nuevo como horario ordinario. Los equipos ambiguos necesitan resolución manual; no hay reclasificación por ausencia momentánea de MDM. Un borrado remoto de permisos, force-stop, restricción del fabricante o reloj incoherente puede interrumpir captura. Mantener FGS visible y auditoría de acceso. Antes de activación real de 24/7, completar revisión de privacidad en Costa Rica y pruebas POCO/Huawei.

Detalle de contratos, matriz, pruebas y gates: [SDD](../../spec-04-gps-device-model/SDD.md).
