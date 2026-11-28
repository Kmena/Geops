# Wave 5 — Solicitud remota de diagnóstico

Estado: **NOT_SUPPORTED** por el transporte actual. No se muestra un botón de ejecución inmediata en el portal. La APK Corporate genera y envía snapshots según eventos y trabajo programado sujeto a Android; el backend no tiene un canal de comandos autenticado ni confirmación de entrega a una instalación. ManageEngine no se usó como atajo de ejecución. Un dispositivo offline o restringido puede no despertar por horas; una petición HTTP del administrador no demuestra entrega ni diagnóstico generado.

Propuesta para una Wave posterior, sujeta a diseño de seguridad y medición física:

1. Registrar una solicitud con UUID, actor, tenant, dispositivo/instalación, motivo acotado, `created_at`, `expires_at` e idempotencia. Exigir `mdm.diagnostics.view`, grants de tenant y capacidad explícita de solicitud; auditar creación.
2. Exponer la orden en el **próximo** intercambio PoP autenticado existente. Responder con estado `PENDING_DELIVERY`; no usar polling agresivo, FGS nuevo ni push MDM sin ensayo.
3. La APK confirma `RECEIVED` con boot/instalación y, si Android permite ejecutarla, produce snapshot con referencia a la solicitud. El backend distingue `GENERATED` de `RECEIVED_BACKEND`. Un snapshot espontáneo no cierra una solicitud sin referencia.
4. Registrar `EXPIRED`, `DEVICE_OFFLINE` y `UNSUPPORTED` con tiempos y causa; no convertir expiración en permiso denegado o servicio detenido. Probar reintentos, reinstalación, logout admin, pérdida de red, Doze, force-stop y BYOD.

No se implementó este contrato en Wave 5 porque el snapshot v1 y el transporte actual no contienen el identificador de solicitud ni el acuse de entrega. La propuesta requiere diseño de migración, revisión de privacidad, pruebas Android y autorización separada. Mientras tanto, el portal permite refrescar la **lectura** del último diagnóstico recibido, con su hora y estado de antigüedad.
