# ADR-002 — GPS propio

**Estado:** decisión inicial; pendiente de validación con Android y el piloto.

## Contexto

La captura de ubicación requiere control sobre horarios, almacenamiento local y sincronización aun con conectividad intermitente.

## Decisión

Un agente Kotlin propio capturará coordenadas mediante Fused Location Provider, las almacenará localmente con Room y las sincronizará con la API Node.js por HTTPS. Se prevé un servicio en primer plano para la captura y WorkManager para trabajos de sincronización compatibles con las restricciones de Android. ManageEngine MDM y Android Enterprise se usarán para administrar dispositivos, instalar el agente y aplicar restricciones compatibles.

## Consecuencias

El agente deberá gestionar permisos, consumo de batería, reintentos y estados de red. La viabilidad de la cadencia GPS, el comportamiento en segundo plano y las políticas MDM deberá comprobarse en los dispositivos piloto. El MDM no se considera fuente de datos GPS para la aplicación.
