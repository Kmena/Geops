# ADR-006 — Privacidad y administración

**Estado:** decisión inicial; reglas operativas pendientes de validación.

## Contexto

El rastreo de dispositivos de trabajo debe limitarse al propósito empresarial y respetar las señales de privacidad y restricciones de Android.

## Decisión

El rastreo operará únicamente durante horarios laborales configurables por dispositivo. El agente tendrá interacción mínima y estará administrado mediante MDM. No intentará ocultar los indicadores obligatorios de privacidad de Android.

## Consecuencias

Antes del piloto deberán definirse avisos y permisos, quién puede cambiar horarios, control de acceso, retención y eliminación de datos, auditoría y tratamiento de excepciones. Las restricciones que ofrezca ManageEngine deberán validarse con la versión de Android y el modo de administración elegido.
