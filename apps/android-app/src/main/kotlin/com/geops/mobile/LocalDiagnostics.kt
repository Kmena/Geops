package com.geops.mobile

import android.Manifest
import android.app.ActivityManager
import android.app.AlarmManager
import android.content.Context
import android.content.ComponentName
import android.content.RestrictionsManager
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.PowerManager
import android.os.UserManager
import com.geops.agent.LocalDiagnosticRules
import com.geops.agent.GeopsLocationService
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

internal data class DiagnosticSection(val title: String, val lines: List<String>)
internal data class PermissionDiagnostic(
    val label: String, val category: String, val purpose: String,
    val desired: String, val effective: String, val impact: String,
    val action: String
)

internal data class LocalDiagnosticReport(
    val observedAt: String,
    val sections: List<DiagnosticSection>,
    val telemetry: JSONObject,
    val permissions: List<PermissionDiagnostic>,
    val lastSyncAttemptAtMs: Long?
) {
    fun sanitizedText(): String = buildString {
        append("GEOPS — Configuración y diagnóstico\n")
        append("Observado: ").append(observedAt).append("\n")
        append("Fuente efectiva: esta APK Android. Fuente MDM: consultar en la pantalla con autorización.\n")
        append("Sin coordenadas, identificadores de dispositivo, credenciales ni tokens.\n")
        sections.forEach { section ->
            append("\n").append(section.title).append("\n")
            section.lines.forEach { append("• ").append(it).append("\n") }
        }
    }
}

/** Read-only Android observation. Never starts GPS, requests a grant or contacts the MDM. */
internal object LocalDiagnostics {
    private data class PermissionSpec(
        val label: String, val name: String, val minApi: Int = 26,
        val runtime: Boolean = true, val desired: Boolean = true,
        val purpose: String = "Habilitar el diagnóstico y seguimiento autorizado",
        val impact: String = "Puede limitar el seguimiento autorizado"
    )

    private val permissions = listOf(
        PermissionSpec("Ubicación precisa", Manifest.permission.ACCESS_FINE_LOCATION,
            purpose = "Permite obtener coordenadas precisas para el seguimiento autorizado",
            impact = "Sin ella no se inicia la captura GPS corporativa"),
        PermissionSpec("Ubicación aproximada", Manifest.permission.ACCESS_COARSE_LOCATION,
            purpose = "Declara la alternativa de ubicación menos precisa de Android",
            impact = "Por sí sola no cumple la precisión requerida por GEOPS"),
        PermissionSpec("Ubicación en segundo plano", Manifest.permission.ACCESS_BACKGROUND_LOCATION, 29,
            purpose = "Permite ubicación mientras la pantalla GEOPS no está visible",
            impact = "Sin ella se bloquea el inicio corporativo en segundo plano"),
        PermissionSpec("Notificaciones", Manifest.permission.POST_NOTIFICATIONS, 33,
            purpose = "Permite mostrar la notificación obligatoria del servicio",
            impact = "La política GEOPS exige este permiso antes del inicio"),
        PermissionSpec("Servicio en primer plano", Manifest.permission.FOREGROUND_SERVICE, 28, false,
            purpose = "Declara la capacidad de usar un servicio visible",
            impact = "La declaración no prueba que el servicio esté ejecutándose"),
        PermissionSpec("Tipo de servicio: ubicación", Manifest.permission.FOREGROUND_SERVICE_LOCATION, 34, false,
            purpose = "Declara el tipo de servicio foreground de ubicación",
            impact = "La declaración no prueba que Android permita iniciar el servicio"),
        PermissionSpec("Reinicio", Manifest.permission.RECEIVE_BOOT_COMPLETED, 26, false,
            purpose = "Permite recibir el reinicio para intentar recuperación autorizada",
            impact = "La declaración no garantiza autoinicio tras force-stop"),
        PermissionSpec("Internet", Manifest.permission.INTERNET, 26, false,
            purpose = "Permite transmitir posiciones y diagnóstico al backend",
            impact = "La declaración no prueba conectividad ni ACK"),
        PermissionSpec("Estado de red", Manifest.permission.ACCESS_NETWORK_STATE, 26, false,
            purpose = "Permite detectar la conectividad observada",
            impact = "La declaración no prueba acceso a Internet"),
        PermissionSpec("Wake lock", Manifest.permission.WAKE_LOCK, 26, false, false,
            purpose = "No requerido por el diseño actual",
            impact = "Su ausencia no demuestra la causa de un fallo GPS")
    )

    private fun observed(block: () -> String): String = runCatching(block).getOrElse { "UNKNOWN" }
    private fun time(ms: Long?): String = ms?.let { Instant.ofEpochMilli(it).toString() } ?: "UNKNOWN"

    fun collect(context: Context): LocalDiagnosticReport {
        val app = context.applicationContext
        val manager = app.packageManager
        val packageInfo = manager.getPackageInfo(app.packageName, PackageManager.GET_PERMISSIONS)
        val declared = packageInfo.requestedPermissions?.toSet() ?: emptySet()
        val runtime = AgentRuntime.localEvidence(app)
        val location = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val power = app.getSystemService(Context.POWER_SERVICE) as PowerManager
        val network = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val restrictions = (app.getSystemService(Context.RESTRICTIONS_SERVICE) as? RestrictionsManager)
            ?.applicationRestrictions
        val permissionStates = mutableMapOf<String, String>()
        val permissionDetails = mutableListOf<PermissionDiagnostic>()
        val permissionLines = permissions.map { spec ->
            val state = LocalDiagnosticRules.permission(
                spec.name in declared,
                Build.VERSION.SDK_INT >= spec.minApi,
                if (Build.VERSION.SDK_INT < spec.minApi || spec.name !in declared) null
                else observed { app.checkSelfPermission(spec.name).toString() }
                    .toIntOrNull()?.let { it == PackageManager.PERMISSION_GRANTED },
                restricted = spec.runtime && spec.name in declared &&
                    runCatching {
                        manager.isPermissionRevokedByPolicy(spec.name, app.packageName)
                    }.getOrDefault(false)
            )
            permissionStates[spec.name] = state.name
            permissionDetails += PermissionDiagnostic(
                spec.label,
                if (spec.runtime) "Permiso de Android" else "Declaración de la APK",
                spec.purpose,
                if (spec.desired) "Requerido" else "No requerido",
                state.name,
                if (state.name == "GRANTED") "Sin bloqueo observado por este permiso" else spec.impact,
                when (state.name) {
                    "DENIED" -> "Abrir permisos de Android o solicitar revisión administrativa"
                    "RESTRICTED" -> "Requiere revisión administrativa de la política"
                    "NOT_DECLARED" -> "Requiere actualización de la APK"
                    "GRANTED" -> "Ninguna"
                    else -> "Verificar en el dispositivo"
                }
            )
            "${spec.label}: deseado ${if (spec.desired) "concedido" else "no requerido"}; " +
                "ManageEngine UNKNOWN; Android ${state.name}" +
                if (spec.name !in declared && Build.VERSION.SDK_INT >= spec.minApi)
                    " (no declarado en APK)" else ""
        }
        val precise = observed {
            when {
                app.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
                    PackageManager.PERMISSION_GRANTED -> "precisa"
                app.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) ==
                    PackageManager.PERMISSION_GRANTED -> "aproximada"
                else -> "sin permiso de ubicación"
            }
        }
        val locationEnabled = observed {
            if (Build.VERSION.SDK_INT >= 28) location.isLocationEnabled.toString()
            else (location.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                location.isProviderEnabled(LocationManager.NETWORK_PROVIDER)).toString()
        }
        val gpsProvider = observed { location.isProviderEnabled(LocationManager.GPS_PROVIDER).toString() }
        val batteryExempt = observed { power.isIgnoringBatteryOptimizations(app.packageName).toString() }
        val powerSave = observed { power.isPowerSaveMode.toString() }
        val backgroundRestricted = observed {
            if (Build.VERSION.SDK_INT >= 28)
                (app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager)
                    .isBackgroundRestricted.toString()
            else "NOT_APPLICABLE"
        }
        val dataSaver = observed {
            when (network.restrictBackgroundStatus) {
                ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED -> "RESTRICTED"
                ConnectivityManager.RESTRICT_BACKGROUND_STATUS_WHITELISTED -> "EXEMPT"
                ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED -> "DISABLED"
                else -> "UNKNOWN"
            }
        }
        val internet = observed {
            val capabilities = network.getNetworkCapabilities(network.activeNetwork)
            when {
                capabilities == null -> "sin red activa"
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) -> "validada"
                else -> "red sin Internet validado"
            }
        }
        val exactAlarm = observed {
            val alarm = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            if (Build.VERSION.SDK_INT >= 31) alarm.canScheduleExactAlarms().toString()
            else "NOT_APPLICABLE"
        }
        val serviceType = observed {
            if (Build.VERSION.SDK_INT < 29) "NOT_APPLICABLE"
            else {
                val info = manager.getServiceInfo(
                    ComponentName(app, GeopsLocationService::class.java), 0
                )
                if (info.foregroundServiceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION != 0)
                    "location declarado" else "location no declarado"
            }
        }
        val managed = if (!AppVariant.corporate) "NOT_APPLICABLE" else when {
            restrictions == null || restrictions.getBoolean(UserManager.KEY_RESTRICTIONS_PENDING, false) ->
                "UNKNOWN (restricciones pendientes)"
            runCatching { AppVariant.requireEnrollment(app) }.isSuccess ->
                "configuración local coincide; estado remoto UNKNOWN"
            else -> "configuración local no coincide"
        }
        val device = DiagnosticSection("Dispositivo y administración", listOf(
            "Paquete: ${app.packageName}; versión: ${packageInfo.versionName ?: "UNKNOWN"} " +
                "(${if (Build.VERSION.SDK_INT >= 28) packageInfo.longVersionCode else packageInfo.versionCode.toLong()})",
            "Fabricante/modelo: ${Build.MANUFACTURER} ${Build.MODEL}; Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            "Modo: ${if (AppVariant.corporate) "CORPORATE_MANAGED" else "PERSONAL_BYOD"}; ManageEngine: $managed",
            "Política aplicada/version ManageEngine: UNKNOWN (API no integrada en Wave 1)"
        ))
        val execution = DiagnosticSection("Ejecución en segundo plano", listOf(
            "FGS GPS observado: ${runtime?.serviceState ?: "UNKNOWN"}",
            "Tipo FGS: $serviceType",
            "Último evento FGS/listener: ${runtime?.lastServiceEvent ?: "UNKNOWN"}",
            "Último inicio confirmado del servicio: ${runtime?.lastServiceStart ?: "UNKNOWN"}",
            "Última interrupción conocida: ${runtime?.lastServiceInterruption ?: "UNKNOWN"}",
            "Ubicación global: $locationEnabled; proveedor GPS: $gpsProvider; precisión: $precise",
            "Exento de optimización de batería: $batteryExempt; ahorro de energía: $powerSave",
            "Ejecución background restringida: $backgroundRestricted; datos background: $dataSaver",
            "Alarma exacta disponible: $exactAlarm",
            "Último intento de recuperación: ${runtime?.lastWake ?: "UNKNOWN"}",
            "Reinicio: receptor declarado; recuperación efectiva tras reinicio UNKNOWN hasta prueba observada"
        ))
        val gps = DiagnosticSection("GPS v2 y sincronización", listOf(
            "Modo efectivo: ${runtime?.trackingMode ?: "UNKNOWN"}; política GEOPS: ${runtime?.policyRevision ?: "UNKNOWN"}",
            "Captura solicitada: ${runtime?.captureIntervalS?.let { "$it s" } ?: "UNKNOWN"}; " +
                "transmisión solicitada: ${runtime?.syncIntervalS?.let { "$it s" } ?: "UNKNOWN"}",
            "Última captura local: ${time(runtime?.lastCaptureAtMs)}",
            "Último intento de transmisión: ${time(runtime?.lastSyncAttemptAtMs)}",
            "Último callback Android: ${time(runtime?.lastCallbackAtMs)}",
            "Última posición confirmada (ACK): ${time(runtime?.lastAckAtMs)}",
            "Posiciones pendientes: ${runtime?.pendingLocations ?: "UNKNOWN"}; transmisión: ${runtime?.transmissionState ?: "UNKNOWN"}",
            "Internet: $internet; autenticación de subida bloqueada: ${runtime?.uploadAuthBlocked ?: "UNKNOWN"}",
            "Último error de captura: ${runtime?.lastCaptureError ?: "UNKNOWN"}",
            "Último error de transmisión: ${runtime?.lastTransmissionError ?: "UNKNOWN"}",
            "Errores recientes: ${runtime?.recentErrors?.takeIf { it.isNotEmpty() }?.joinToString("; ") ?: "UNKNOWN"}"
        ))
        val sections = listOf(device, DiagnosticSection("Permisos de la APK", permissionLines), execution, gps)
        fun nullable(value: Any?): Any = value ?: JSONObject.NULL
        fun epoch(value: Long?): Any = nullable(value?.let { Instant.ofEpochMilli(it).toString() })
        fun plain(value: String): String = value.replace(Regex("[^\\p{L}\\p{N} ._-]"), "_")
            .take(80).ifBlank { "UNKNOWN" }
        val observedAt = Instant.now().toString()
        val errors = JSONArray()
        runtime?.recentErrors?.forEach { raw ->
            val code = raw.substringBefore(" @ ").replace(": ", "_")
            val at = raw.substringAfter(" @ ", "")
            if (code.matches(Regex("[A-Z][A-Z0-9_]{2,79}")) && at.isNotEmpty())
                errors.put(JSONObject().put("code", code).put("observed_at", at))
        }
        val wire = JSONObject()
            .put("schema_version", 1)
            .put("observed_at", observedAt)
            .put("app_version", plain(packageInfo.versionName ?: "UNKNOWN"))
            .put("manufacturer", plain(Build.MANUFACTURER))
            .put("model", plain(Build.MODEL))
            .put("android_release", plain(Build.VERSION.RELEASE))
            .put("android_api", Build.VERSION.SDK_INT)
            .put("permissions", JSONObject()
                .put("fine", permissionStates[Manifest.permission.ACCESS_FINE_LOCATION] ?: "UNKNOWN")
                .put("coarse", permissionStates[Manifest.permission.ACCESS_COARSE_LOCATION] ?: "UNKNOWN")
                .put("background", permissionStates[Manifest.permission.ACCESS_BACKGROUND_LOCATION] ?: "UNKNOWN")
                .put("notifications", permissionStates[Manifest.permission.POST_NOTIFICATIONS] ?: "UNKNOWN"))
            .put("execution", JSONObject()
                .put("location_enabled", nullable(locationEnabled.toBooleanStrictOrNull()))
                .put("gps_provider_enabled", nullable(gpsProvider.toBooleanStrictOrNull()))
                .put("battery_exempt", nullable(batteryExempt.toBooleanStrictOrNull()))
                .put("power_save", nullable(powerSave.toBooleanStrictOrNull()))
                .put("background_restricted", nullable(backgroundRestricted.toBooleanStrictOrNull()))
                .put("data_saver", dataSaver)
                .put("internet", when (internet) {
                    "validada" -> "VALIDATED"
                    "sin red activa" -> "OFFLINE"
                    "red sin Internet validado" -> "UNVALIDATED"
                    else -> "UNKNOWN"
                }))
            .put("gps", JSONObject()
                .put("service", runtime?.serviceState ?: "UNKNOWN")
                .put("last_callback_at", epoch(runtime?.lastCallbackAtMs))
                .put("last_capture_at", epoch(runtime?.lastCaptureAtMs))
                .put("last_ack_at", epoch(runtime?.lastAckAtMs))
                .put("pending_positions", nullable(runtime?.pendingLocations))
                .put("upload_auth_blocked", nullable(runtime?.uploadAuthBlocked))
                .put("capture_interval_s", nullable(runtime?.captureIntervalS))
                .put("sync_interval_s", nullable(runtime?.syncIntervalS))
                .put("policy_revision", nullable(runtime?.policyRevision))
                .put("tracking_mode", runtime?.trackingMode ?: "UNKNOWN"))
            .put("errors", errors)
        return LocalDiagnosticReport(observedAt, sections, wire, permissionDetails,
            runtime?.lastSyncAttemptAtMs)
    }
}
