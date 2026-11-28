package com.geops.mobile

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import com.geops.agent.GpsSummaryState
import com.geops.agent.LocalDiagnosticRules
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import org.json.JSONObject

/** Corporate diagnostics. Administrative login never changes the device GPS runtime. */
class DiagnosticActivity : ComponentActivity() {
    private val work = Executors.newSingleThreadExecutor()
    private lateinit var content: LinearLayout
    private lateinit var status: TextView
    private var report: LocalDiagnosticReport? = null
    private var mdm: JSONObject? = null
    private var caps: JSONObject? = null
    private var diagnosis: JSONObject? = null
    private var history: JSONObject? = null
    private var preview: JSONObject? = null
    private var previewReason = ""
    private var previewRequestKey: String? = null
    private var remoteError: String? = null
    private var busy = false
    private val ink = Color.rgb(25, 45, 58)
    private val muted = Color.rgb(80, 96, 107)
    private val accent = Color.rgb(11, 83, 107)
    private val gap get() = (12 * resources.displayMetrics.density).toInt()

    private val saveReport = registerForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
        val output = report?.let(::sanitizedExport) ?: return@registerForActivityResult
        if (uri != null) {
            val saved = runCatching {
                contentResolver.openOutputStream(uri)?.use { it.write(output.toByteArray(Charsets.UTF_8)) }
                    ?: error("output_unavailable")
            }.isSuccess
            status.text = if (saved) "Reporte técnico guardado." else "No se pudo guardar el reporte."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!AppVariant.corporate) { finish(); return }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(gap, gap, gap, gap)
            setBackgroundColor(Color.rgb(247, 249, 250))
        }
        root.addView(label("Configuración y diagnóstico", 24f, ink))
        status = label("Leyendo el estado de este teléfono…", 14f, muted)
        root.addView(status)
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        actions.addView(button("Actualizar") { refresh() }, weight())
        actions.addView(button("Exportar") {
            if (report != null) saveReport.launch("GEOPS-diagnostico-${System.currentTimeMillis()}.txt")
        }, weight())
        root.addView(actions)
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(content)
        setContentView(ScrollView(this).apply { isFillViewport = true; addView(root) })
        refresh()
    }
    private fun weight() = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    private fun label(value: String, size: Float = 15f, color: Int = ink) = TextView(this).apply {
        text = value; textSize = size; setTextColor(color); setPadding(0, gap / 4, 0, gap / 4)
    }
    private fun button(title: String, action: () -> Unit) = Button(this).apply {
        text = title; minHeight = (48 * resources.displayMetrics.density).toInt()
        setOnClickListener { action() }
    }
    private fun field(hint: String, secret: Boolean = false) = EditText(this).apply {
        this.hint = hint
        inputType = if (secret) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            else InputType.TYPE_CLASS_TEXT
        setSingleLine(true)
        minHeight = (48 * resources.displayMetrics.density).toInt()
    }
    private fun card(title: String, block: (LinearLayout) -> Unit) {
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(gap, gap, gap, gap)
            setBackgroundColor(Color.WHITE)
        }
        panel.addView(label(title, 19f, accent))
        block(panel)
        content.addView(panel, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = gap })
    }
    private fun line(panel: LinearLayout, value: String, color: Int = ink) {
        panel.addView(label(value, 15f, color))
    }
    private fun onUi(action: () -> Unit) = runOnUiThread { if (!isFinishing && !isDestroyed) action() }
    private fun runTask(message: String, task: () -> Unit) {
        if (busy || work.isShutdown) return
        busy = true; status.text = message
        work.execute {
            try { task() }
            catch (failure: Exception) { onUi { status.text = readableError(failure) } }
            finally { onUi { busy = false } }
        }
    }
    private fun refresh() = runTask("Actualizando diagnóstico local…") {
        val local = LocalDiagnostics.collect(applicationContext)
        onUi { report = local; status.text = "Observado: ${local.observedAt}"; render() }
        if (AdminApiClient.session() != null) loadRemote()
    }
    private fun loadRemote() {
        val id = deviceId() ?: return
        val session = try { AdminApiClient.verify() } catch (failure: Exception) {
            onUi { remoteError = readableError(failure); render() }; return
        }
        if (!session.has("mdm.diagnostics.view")) {
            onUi { remoteError = "Tu usuario no tiene permiso de diagnóstico MDM."; render() }
            return
        }
        val path = "/v1/admin/mdm/devices/$id"
        val newDiagnosis = runCatching { AdminApiClient.get("$path/diagnostics") }.getOrNull()
        val newMdm = if (session.has("mdm.policies.view"))
            runCatching { AdminApiClient.get("$path/configuration") }.getOrNull() else null
        val newCaps = if (session.has("mdm.policies.view"))
            runCatching { AdminApiClient.get("/v1/admin/mdm/capabilities") }.getOrNull() else null
        val newHistory = if (session.has("mdm.audit.view"))
            runCatching { AdminApiClient.get("$path/remediations") }.getOrNull() else null
        onUi {
            diagnosis = newDiagnosis; mdm = newMdm; caps = newCaps; history = newHistory
            remoteError = if (newDiagnosis == null)
                "Backend no disponible o dispositivo fuera de tu organización." else null
            render()
        }
    }
    private fun deviceId(): String? = getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
        .getString("device_id", null)?.takeIf { it.matches(Regex("^[0-9a-fA-F-]{36}$")) }
    private fun textOf(json: JSONObject?, key: String) = json?.optString(key)
        ?.takeIf { it.isNotBlank() && it != "null" } ?: "No disponible"
    private fun state(raw: String?): String = when (raw) {
        "GRANTED", "AVAILABLE", "VALID", "RUNNING_OBSERVED" -> "Concedido u observado"
        "DENIED", "NOT_DECLARED", "STOPPED_OBSERVED" -> "No concedido o detenido observado"
        "RESTRICTED" -> "Restringido"
        "NOT_APPLICABLE", "NOT_SUPPORTED" -> "No compatible"
        "UNAVAILABLE" -> "No disponible"
        "UNKNOWN", null -> "Pendiente de verificación"
        else -> raw.replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() }
    }
    private fun readableError(failure: Exception): String = when (failure) {
        is AdminApiClient.ApiFailure -> when (failure.code) {
            "invalid_credentials" -> "Credenciales incorrectas."
            "rate_limited" -> "Demasiados intentos. Espera antes de volver a entrar."
            "recent_login_required" -> "Vuelve a iniciar sesión antes de esta operación."
            "mdm_write_disabled" -> "La escritura ManageEngine sigue bloqueada por el backend."
            "different_admin" -> "La reautenticación debe ser del mismo usuario."
            "unauthorized", "session_missing" -> "Sesión vencida o revocada. Inicia sesión otra vez."
            else -> when (failure.status) {
                403 -> "No tienes permiso para esta operación o dispositivo."
                409 -> "La vista previa cambió. Actualiza antes de solicitar."
                else -> "No se completó la consulta (${failure.code})."
            }
        }
        else -> "Sin conexión o datos no disponibles. Comprueba Internet y vuelve a intentar."
    }
    private fun render() {
        val local = report ?: return
        content.removeAllViews()
        renderDevice(local); renderPermissions(local); renderBattery(local); renderGps(local)
        renderMdm(); renderGpsConfig(local); renderConnectivity(local); renderReport(local); renderAuth()
    }
    private fun renderDevice(local: LocalDiagnosticReport) = card("1. Información del dispositivo") { p ->
        local.sections.firstOrNull()?.lines?.forEach { line(p, it) }
        val authorized = AdminApiClient.session()?.has("mdm.diagnostics.view") == true
        val id = deviceId()
        line(p, "Identidad GEOPS: ${if (authorized) id ?: "No disponible" else id?.let { "••••${it.takeLast(6)}" } ?: "Pendiente"}")
        line(p, "Agente asignado (backend): ${if (authorized) textOf(mdm, "agent_id") else "Requiere administrador"}")
        line(p, "Organización (backend): ${if (authorized) textOf(mdm, "tenant_id") else "Requiere administrador"}")
        val activated = !getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
            .getString("key_id", null).isNullOrBlank()
        line(p, "Activación local: ${if (activated) "Clave presente; validar en backend" else "Pendiente"}")
        line(p, "ID ManageEngine verificado: ${if (authorized) textOf(mdm, "mdm_device_id") else "Requiere administrador"}")
        line(p, "Último contacto MDM: ${textOf(mdm, "inventory_last_seen_at")}")
        line(p, "Última comunicación backend: ${textOf(diagnosis, "last_communication_at")}")
        val enrolled = getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
            .getBoolean("managed_enrolled", false)
        line(p, "Enrolamiento local: ${if (enrolled) "MDM configurado localmente; validar remoto" else "No confirmado"}")
        line(p, "Último diagnóstico local: ${local.observedAt}")
    }
    private fun renderPermissions(local: LocalDiagnosticReport) = card("2. Permisos Android") { p ->
        line(p, "Android efectivo: ${local.observedAt}. MDM asignado y aplicado: pendientes por permiso.", muted)
        local.permissions.forEach { item ->
            line(p, "${item.label}: ${state(item.effective)}", accent)
            line(p, "${item.category}. ${item.purpose}. Deseado: ${item.desired}; asignado: no disponible; aplicado MDM: pendiente.")
            line(p, "Impacto: ${item.impact}. Acción: ${item.action}.", muted)
        }
        p.addView(button("Abrir permisos de Android") { openSettings() })
    }
    private fun renderBattery(local: LocalDiagnosticReport) = card("3. Batería y segundo plano") { p ->
        local.sections.find { it.title == "Ejecución en segundo plano" }?.lines?.forEach { line(p, it) }
        line(p, "La exención de batería no garantiza ejecución permanente.", muted)
        p.addView(button("Abrir ajustes de esta APK") { openSettings() })
    }
    private fun renderGps(local: LocalDiagnosticReport) = card("4. Diagnóstico GPS v2") { p ->
        val gps = local.telemetry.optJSONObject("gps")
        val execution = local.telemetry.optJSONObject("execution")
        fun time(key: String): Long? = runCatching {
            gps?.optString(key)?.takeIf { it.isNotBlank() && it != "null" }
                ?.let { Instant.parse(it).toEpochMilli() }
        }.getOrNull()
        val summary = when (LocalDiagnosticRules.gpsSummary(
            gps?.optString("service"), execution?.optString("internet"),
            gps?.optInt("capture_interval_s", 0)?.takeIf { it > 0 },
            time("last_capture_at"), time("last_ack_at"),
            gps?.optInt("pending_positions", -1)?.takeIf { it >= 0 },
            System.currentTimeMillis()
        )) {
            GpsSummaryState.STOPPED_OBSERVED -> "Servicio detenido confirmado por evento reciente"
            GpsSummaryState.OFFLINE -> "Dispositivo sin red; GPS y cola se evalúan por separado"
            GpsSummaryState.CAPTURE_STALE -> "Servicio activo sin captura reciente"
            GpsSummaryState.CAPTURE_PENDING_UPLOAD -> "Captura activa con transmisión pendiente"
            GpsSummaryState.CAPTURE_ACK_OBSERVED -> "Servicio, captura y ACK observados"
            GpsSummaryState.UNKNOWN -> "Estado GPS pendiente de verificación"
        }
        line(p, summary, accent)
        val received = diagnosis?.optString("received_at")?.takeIf { it.isNotBlank() }
        val stale = runCatching {
            received == null || Instant.now().toEpochMilli() - Instant.parse(received).toEpochMilli() > 15 * 60_000L
        }.getOrDefault(true)
        line(p, "Diagnóstico backend: ${if (stale) "Desactualizado o no disponible" else "Reciente"}",
            if (stale) muted else accent)
        line(p, "Servicio: ${state(gps?.optString("service"))}", accent)
        line(p, "Última captura: ${textOf(gps, "last_capture_at")}")
        line(p, "Último intento de transmisión: ${local.lastSyncAttemptAtMs?.let { Instant.ofEpochMilli(it) } ?: "No disponible"}")
        line(p, "Último callback Android: ${textOf(gps, "last_callback_at")}")
        line(p, "Último ACK: ${textOf(gps, "last_ack_at")}")
        line(p, "Posiciones pendientes: ${textOf(gps, "pending_positions")}")
        line(p, "Autenticación técnica bloqueada: ${textOf(gps, "upload_auth_blocked")}")
        local.sections.find { it.title == "GPS v2 y sincronización" }?.lines?.forEach { line(p, it, muted) }
        val findings = diagnosis?.optJSONArray("findings")
        if (findings == null) line(p, "Hallazgos backend: pendientes de verificación.")
        else for (i in 0 until findings.length())
            line(p, "Hallazgo: ${state(findings.optJSONObject(i)?.optString("code"))}")
        line(p, "La ausencia de posiciones no demuestra que el servicio esté detenido.", muted)
    }
    private fun renderMdm() = card("5. Administración ManageEngine") { p ->
        val session = AdminApiClient.session()
        if (session == null) { line(p, "Inicia sesión como administrador autorizado."); return@card }
        if (!session.has("mdm.policies.view")) { line(p, "Requiere permiso para consultar políticas MDM."); return@card }
        line(p, "Proveedor: ManageEngine · tenant: no verificado", accent)
        line(p, "Vinculación: ${state(mdm?.optString("link_state"))}; lectura: ${state(mdm?.optString("read_state"))}")
        line(p, "ID verificado: ${textOf(mdm, "mdm_device_id")}; último contacto: ${textOf(mdm, "inventory_last_seen_at")}")
        line(p, "Escritura: bloqueada. Lectura real pendiente de tenant, edición y licencia.")
        line(p, "Deseado: ${textOf(mdm?.optJSONObject("desired"), "ownership")}; seguimiento: ${textOf(mdm?.optJSONObject("desired"), "tracking_authorized")}")
        val assigned = mdm?.optJSONObject("assigned")
        line(p, "Perfiles asignados: ${state(assigned?.optString("state"))}")
        assigned?.optJSONArray("items")?.let { items -> for (i in 0 until items.length()) {
            val item = items.optJSONObject(i)
            line(p, "Perfil ${textOf(item, "profile_id")}: ${state(item?.optString("distribution"))}")
        } }
        line(p, "Perfiles aplicados reportados: ${mdm?.optJSONArray("applied_reported")?.length() ?: 0}")
        line(p, "Aplicación administrada: ${if (mdm?.optJSONObject("app") == null) "No disponible" else "Reportada por MDM"}")
        line(p, "Configuración efectiva Android: ver sección Permisos Android.")
        caps?.optJSONArray("capabilities")?.let { list -> for (i in 0 until list.length()) {
            val c = list.optJSONObject(i)
            line(p, "${textOf(c, "key")}: ${state(c?.optString("state"))}", muted)
        } }
        mdm?.optJSONArray("findings")?.let { list -> for (i in 0 until list.length())
            line(p, "Discrepancia: ${state(list.optJSONObject(i)?.optString("code"))}") }
        remoteError?.let { line(p, it, muted) }
        renderCorrections(p, session)
    }
    private fun renderCorrections(p: LinearLayout, session: AdminApiClient.Session) {
        line(p, "Correcciones administrativas", accent)
        mdm?.optJSONArray("correction_actions")?.let { list -> for (i in 0 until list.length()) {
            val item = list.optJSONObject(i)
            line(p, "${state(item?.optString("classification"))}: ${textOf(item, "reason")}")
        } }
        line(p, "AUTO_MDM: no confirmado · APP_CONFIGURATION: no confirmado · requiere consola o investigación.")
        if (session.has("mdm.audit.view")) {
            val items = history?.optJSONArray("items")
            line(p, "Historial: ${items?.length() ?: 0} solicitudes visibles")
            if (items != null) for (i in 0 until items.length()) {
                val item = items.optJSONObject(i)
                line(p, "${textOf(item, "requested_at")}: ${state(item?.optString("state"))} · perfil ${textOf(item, "profile_id")}")
            }
        }
        if (!session.has("mdm.permissions.remediate")) {
            line(p, "Vista previa y solicitud: requiere permiso administrativo."); return
        }
        val profile = field("ID numérico de perfil verificado")
        val reason = field("Motivo de solicitud, mínimo 8 caracteres")
        p.addView(profile); p.addView(reason)
        p.addView(button("Generar vista previa") {
            val id = deviceId() ?: return@button
            val profileId = profile.text.toString().trim()
            if (!profileId.matches(Regex("^[0-9]{1,30}$"))) {
                status.text = "Introduce un ID numérico de perfil válido."; return@button
            }
            val requestedReason = reason.text.toString().trim()
            runTask("Consultando impacto sin modificar ManageEngine…") {
                val result = AdminApiClient.post("/v1/admin/mdm/remediations/preview",
                    JSONObject().put("device_id", id).put("profile_id", profileId))
                onUi {
                    preview = result; previewReason = requestedReason
                    previewRequestKey = UUID.randomUUID().toString()
                    status.text = if (result.optBoolean("eligible"))
                        "Vista previa: un dispositivo. Escritura MDM bloqueada."
                    else "Corrección bloqueada: ${textOf(result, "reason")}."
                    render()
                }
            }
        })
        preview?.let { current ->
            line(p, "Vista previa: ${textOf(current, "reason")}; impacto: ${textOf(current, "impact_device_count")}")
            if (current.optBoolean("eligible") && current.optString("preview_digest").matches(Regex("[0-9a-f]{64}")))
                p.addView(button("Solicitar revisión administrativa") {
                    if (previewReason.length !in 8..240) {
                        status.text = "Indica un motivo de 8 a 240 caracteres."; return@button
                    }
                    AlertDialog.Builder(this).setTitle("Confirmar solicitud")
                        .setMessage("Se registrará una solicitud para un dispositivo. No se aplicará ningún cambio MDM.")
                        .setNegativeButton("Cancelar", null)
                        .setPositiveButton("Registrar") { _, _ -> requestCorrection(current, previewReason) }
                        .show()
                })
        }
    }
    private fun requestCorrection(current: JSONObject, reason: String) = runTask("Registrando solicitud…") {
        val body = JSONObject().put("device_id", current.getString("device_id"))
            .put("profile_id", current.getString("profile_id"))
            .put("preview_digest", current.getString("preview_digest"))
            .put("idempotency_key", previewRequestKey ?: error("preview_missing"))
            .put("reason", reason)
        val result = AdminApiClient.post("/v1/admin/mdm/remediations/requests", body)
        onUi { status.text = "Solicitud ${textOf(result, "request_id")} registrada; sin cambio MDM aplicado." }
        loadRemote()
    }
    private fun renderGpsConfig(local: LocalDiagnosticReport) = card("6. Configuración GPS") { p ->
        val gps = local.telemetry.optJSONObject("gps")
        line(p, "Captura efectiva: ${textOf(gps, "capture_interval_s")} s · fuente: política GPS v2 local")
        line(p, "Transmisión efectiva: ${textOf(gps, "sync_interval_s")} s · fuente: política GPS v2 local")
        line(p, "Modo: ${textOf(gps, "tracking_mode")} · revisión: ${textOf(gps, "policy_revision")}")
        line(p, "Precisión, sincronización detallada y última modificación: no disponibles en este diagnóstico.")
        line(p, "Cambio desde APK: no habilitado; no existe contrato seguro de actualización de estos parámetros.", muted)
    }
    private fun renderConnectivity(local: LocalDiagnosticReport) = card("7. Conectividad y sincronización") { p ->
        val execution = local.telemetry.optJSONObject("execution")
        line(p, "Internet: ${state(execution?.optString("internet"))}")
        line(p, "Datos en segundo plano: ${state(execution?.optString("data_saver"))}")
        line(p, "Último diagnóstico recibido por backend: ${textOf(diagnosis, "received_at")}")
        line(p, "Cola y transmisión: ver Diagnóstico GPS v2.")
    }
    private fun renderReport(local: LocalDiagnosticReport) = card("8. Reportes técnicos") { p ->
        line(p, "Exporta texto sanitizado mediante el selector estándar de Android.")
        line(p, "Incluye fuentes, tiempos, permisos, batería, GPS, conectividad y hallazgos disponibles.")
        line(p, "Excluye coordenadas, contraseñas, tokens e identificadores completos.", muted)
        line(p, "Observado localmente: ${local.observedAt}")
    }
    private fun renderAuth() = card("9. Sesión administrativa") { p ->
        val session = AdminApiClient.session()
        if (session == null) line(p, "Entra con tu usuario GEOPS autorizado. El GPS sigue sin esta sesión.")
        else {
            line(p, "Usuario: ${session.email}; vence como máximo: ${session.expiresAt}")
            line(p, "Permisos actuales: ${session.permissions.sorted().joinToString().ifBlank { "Ninguno" }}")
            line(p, "Para correcciones sensibles, vuelve a entrar antes de continuar.", muted)
            p.addView(button("Cerrar sesión") {
                runTask("Cerrando sesión administrativa…") {
                    AdminApiClient.logout()
                    onUi {
                        mdm = null; caps = null; diagnosis = null; history = null
                        preview = null; previewRequestKey = null
                        status.text = "Sesión cerrada. El GPS no se modificó."; render()
                    }
                }
            })
        }
        val email = field("Correo GEOPS")
        val password = field("Contraseña", true)
        if (session != null) email.setText(session.email)
        p.addView(email); p.addView(password)
        p.addView(button(if (session == null) "Iniciar sesión" else "Reautenticarse") {
            val chars = CharArray(password.text.length) { password.text[it] }
            val address = email.text.toString().trim()
            password.text.clear()
            if (address.isBlank() || chars.isEmpty()) {
                chars.fill('\u0000'); status.text = "Escribe tu correo y contraseña GEOPS."
                return@button
            }
            runTask("Validando sesión y permisos…") {
                try {
                    val logged = AdminApiClient.login(address, chars)
                    onUi { status.text = "Sesión de ${logged.email} verificada."; render() }
                    loadRemote()
                } finally { chars.fill('\u0000') }
            }
        })
    }
    private fun openSettings() {
        runCatching { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:$packageName"))) }.onFailure {
            status.text = "Android no abrió ajustes. Solicita revisión administrativa."
        }
    }
    private fun sanitizedExport(local: LocalDiagnosticReport): String = buildString {
        append(local.sanitizedText())
        append("\nEstado MDM: ")
        append(if (mdm == null) "no disponible o sin autorización" else
            "vinculación ${textOf(mdm, "link_state")}; lectura ${textOf(mdm, "read_state")}")
        append("\nÚltima observación backend: ").append(textOf(diagnosis, "received_at"))
        append("\nHallazgos backend: ")
        val findings = diagnosis?.optJSONArray("findings")
        if (findings == null) append("no disponibles")
        else for (i in 0 until findings.length()) {
            if (i > 0) append(", ")
            append(findings.optJSONObject(i)?.optString("code", "UNKNOWN")?.take(80))
        }
        append("\nExportado: ").append(Instant.now()).append('\n')
    }
    override fun onDestroy() { work.shutdown(); super.onDestroy() }
}
