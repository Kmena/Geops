# R2 — Continuidad Android y ADR-017 (20/10/2026)

**Estado:** `CONDITIONAL_PASS` sintético. La autorización de instancias, la transición de políticas y la compilación Android se verifican localmente; no existe evidencia de continuidad operativa en teléfonos. R3 no se inicia. Este corte parte del HEAD aislado `c27f656` y conserva los cambios R1 sin confirmar. El checkout principal y Web permanecen separados.

## Decisiones implementadas

| Prioridad | Cambio | Límite de seguridad |
| --- | --- | --- |
| ADR-017 | `PolicyEngine.refresh` guarda en el estado cifrado la **instancia exacta vigente durante la respuesta autenticada online**: sesión programada, inicio/fin UTC, versión de asignación, revisión y ancla. `assess` exige coincidencia antes de autorizar. | Una ventana futura anunciada previamente no se activa offline. El fin `[inicio,fin)`, `offline_not_after`, vigencia, ancla monotónica, boot y tombstone siguen cerrando la autorización. Un estado antiguo sin marcador exige una nueva consulta online. |
| Continuidad del FGS iniciado | La intención de seguimiento se guarda cifrada solo después de registrar el listener y crear una sesión efectiva. Ante redelivery del servicio por Android, `AgentRuntime.recover` exige esa intención, identidad/instalación, mismo boot, instancia aún vigente y ausencia de última salida `REASON_USER_REQUESTED`. Intenta refrescar online; solo ante fallo transitorio de red o 429/5xx usa la instancia local todavía válida. | `START_REDELIVER_INTENT` solicita una oportunidad de reconstrucción, **no la garantiza**. No hay receiver de boot, alarma, inicio diario ni permiso background. Si falta cualquier precondición, se cierra el servicio sin llamar a ubicación. La acción local «Detener seguimiento» borra la intención. |
| Transición de política | Una revisión, ventana, actividad o plazo más restrictivo pausa y desregistra el listener antes de sustituir el snapshot. Después del commit local, `tick` evalúa la nueva autorización y, si corresponde, inicia una sesión nueva en el mismo FGS. Un token de generación descarta callbacks del listener viejo, incluso si llegaron a la cola de ejecución. | No se usa la revisión anterior durante el estado intermedio. Tombstone, ventana eliminada, permiso faltante o fallo al registrar detienen la captura. Las posiciones ya persistidas conservan versión/sesión originales. No se cambió su aceptación backend. |

La política `GPS-OFFLINE-001` sigue permitiendo, dentro de **la misma instancia** validada online y antes de su vencimiento, capturas bajo la última revisión conocida aunque el servidor publique una reducción que el teléfono desconectado aún desconoce. Una vez recibida y validada la nueva revisión, se aplica inmediatamente. El transporte histórico y cualquier cambio de reglas backend permanecen para revisión separada.

## Evidencia sintética

`syntheticTest` comprueba ventana actual offline, fin, vencimiento, ventana futura y nueva jornada sin validación, refresh online posterior, reducción y tombstone, boot distinto, marcador/intención cifrados y compatibilidad de estado v1. La transición verifica pausa previa, ausencia de hard-stop del FGS cuando la nueva política autoriza, una sola registración activa, rechazo de fix de generación anterior y detención ante revocación. La compilación `assembleDebug` comprueba manifest, `Application`, Service y runtime; no prueba entrega real de redelivery ni permisos del SO.

| Comprobación local | Resultado | Límite |
| --- | --- | --- |
| `gradle syntheticTest --offline` | **PASS: 28 casos**, incluidos dos R2 nuevos y regresiones R1/SPEC-01. | JVM sintética; no ejerce el ciclo de vida real de Android. |
| `gradle assembleDebug --offline` | **PASS**, 35 tareas. | APK debug compilada; no instalada ni firmada como release. |
| `npm run contracts:check` | **PASS** | No se alteraron rutas ni esquemas API. |
| `npm run security:scan` | **PASS**, 386 archivos elegibles. | Escaneo local; no equivale a revisión independiente. |
| `git diff --check` | **PASS** | No valida archivos nuevos hasta su inclusión en el índice Git. |

## Plan físico pendiente: dos teléfonos

Seleccionar dos Android corporativos autorizados de fabricantes distintos y registrar fabricante, versión Android/target, estado de batería y permisos sin incluir ID ni coordenadas en el informe. Para cada equipo, con una política de prueba y ventana breve:

1. Iniciar manualmente desde Activity visible; comprobar notificación, listener único, `STARTED`, callback, persistencia y ACK.
2. Desconectar red dentro de esa instancia; comprobar continuidad solo hasta el menor entre fin de ventana, vigencia y `offline_not_after`.
3. Matar **el proceso de prueba** sin usar Force Stop y observar si Android redelivera; si lo hace, verificar que antes del primer callback se reconstruyen identidad, permiso, boot, instancia y sesión. Registrar si Android no lo recrea.
4. Usar «Detener seguimiento» y, por separado, Task Manager Stop/Force Stop; comprobar que no reaparece captura sin una nueva acción visible del usuario.
5. Publicar una revisión más restrictiva durante el turno; comprobar cero listeners duplicados, rechazo de callbacks anteriores y ausencia de captura fuera del nuevo intervalo. Probar tombstone.
6. Esperar fin de turno, reiniciar teléfono y comenzar una nueva jornada sin contacto online; comprobar cero nuevas lecturas hasta validación online y nuevo inicio manual.
7. Repetir con pantalla apagada y restricciones de batería documentadas; medir timestamps del fix, callback, cola y ACK por separado. No prometer una lectura por minuto.

No se realizaron estas pruebas ni se instaló APK. La evidencia debe anonimizarse y contar con autorización de privacidad para el piloto.

## Riesgos y gates

- Android 12+ restringe el inicio de FGS en segundo plano y Android 14+ comprueba permisos de ubicación al crearlo. El redelivery de un servicio ya iniciado depende del SO/OEM; una excepción de promoción cierra la captura. [Restricciones oficiales](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), [Service API](https://developer.android.com/reference/android/app/Service).
- En Android 13+ Task Manager Stop termina el proceso sin callback. La consulta de `ApplicationExitInfo` se aplica al recuperar, pero la señal puede clasificar otras acciones del usuario y no sustituye una prueba física. [Guía oficial](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping).
- El estado persistido anterior a R2 carece de `validated_instance` y falla cerrado hasta refresh online. La restauración de datos/clave incompatible también falla cerrada.
- Las pruebas JVM no ejercitan AndroidKeyStore, callbacks en main Looper, restricciones OEM, Doze ni la carrera real entre redelivery y Task Manager. Se requiere el plan físico antes de `PASS` operativo.
- El checkout principal conserva cambios Android sin confirmar sobre varios archivos también modificados aquí. La integración exige revisión por diff y resolución dirigida; no copiar o fusionar Web.
- R3, transporte independiente fuera del horario, sigue pendiente. Los eventos en cola pueden quedar sin envío al detenerse R2 en fin de ventana.

**Gate:** `CONDITIONAL_PASS` de R2 sintético. No desplegar, no integrar al checkout principal ni afirmar continuidad física hasta completar pruebas en dos teléfonos, revisión de seguridad/privacidad y conciliación Git. No añadir `ACCESS_BACKGROUND_LOCATION` ni inicio diario automático por inferencia de estos resultados.
