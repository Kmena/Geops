package com.geops.mobile

import android.Manifest
import android.content.ComponentName
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.os.UserManager
import android.content.RestrictionsManager
import android.provider.Settings
import android.net.Uri
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import com.geops.agent.AndroidKeys
import com.geops.agent.ActivationTicket
import com.geops.agent.EnrollmentClient
import com.geops.agent.EnrollmentHttpException
import com.geops.agent.EnrollmentTicket
import com.geops.agent.GeopsLocationService
import com.geops.agent.HttpsEnrollmentTransport
import com.geops.agent.RefreshingSessionProvider
import com.geops.agent.SYNTHETIC_STAGING_BASE_URL
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.time.Instant
import java.util.concurrent.Executors

/** Visible supervised enrollment and diagnostic UI; policy values are read-only from the server. */
class EnrollmentActivity : ComponentActivity() {
    private val work = Executors.newSingleThreadExecutor()
    private lateinit var deviceField: EditText
    private lateinit var mdmField: EditText
    private lateinit var invitationField: EditText
    private lateinit var secretField: EditText
    private lateinit var keyField: EditText
    private lateinit var installationField: EditText
    private lateinit var status: TextView
    private lateinit var diagnostics: TextView
    private val diagnosticHandler = Handler(Looper.getMainLooper())
    private var diagnosticInFlight = false
    private val diagnosticRefresh = object : Runnable {
        override fun run() {
            if (!visible || work.isShutdown) return
            if (!diagnosticInFlight) {
                diagnosticInFlight = true
                work.execute {
                    val report = runCatching { AgentRuntime.diagnostics(applicationContext) }
                        .getOrElse { "No se pudo leer el diagnóstico local. Vuelve a abrir GEOPS." }
                    runOnUiThread {
                        if (visible) diagnostics.text = report
                        diagnosticInFlight = false
                    }
                }
            }
            diagnosticHandler.postDelayed(this, 5_000L)
        }
    }
    private lateinit var scannerButton: Button
    private lateinit var claimButton: Button
    private var enrollmentInFlight = false
    private var managedEnrollmentInFlight = false
    private var trackingStartInFlight = false
    private var restrictionsReceiverRegistered = false
    private val restrictionsReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_APPLICATION_RESTRICTIONS_CHANGED) {
                tryManagedEnrollment()
                maybeStartManagedTracking()
            }
        }
    }
    private var completedInvitationId: String? = null
    private var completionMessage: String? = null
    private val qrScanner = registerForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (contents == null) {
            show("No se leyó el QR. Comprueba el permiso de cámara, vuelve a escanear o introduce los datos manualmente.")
            return@registerForActivityResult
        }
        if (runCatching { org.json.JSONObject(contents).optString("format") }.getOrNull() == "geops-activation-v1") {
            val activation = try { ActivationTicket.parseActive(contents) }
                catch (failure: Exception) {
                    show(if (failure.message == "activation_expired")
                        "El QR de activación venció. Actualiza GEOPS Web y vuelve a escanear."
                        else "El QR de activación no es válido. Muéstralo de nuevo en GEOPS Web.")
                    return@registerForActivityResult
                }
            val saved = getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
            if (saved.getString("device_id", null) != activation.deviceId ||
                runCatching { AndroidKeys.existingEnrollmentSigner(AgentRuntime.SIGNING_ALIAS) }.isFailure) {
                show("Este QR corresponde a otro equipo o falta la clave de inscripción. Inscribe este teléfono primero.")
                return@registerForActivityResult
            }
            saved.edit().putString("key_id", activation.keyId)
                .putString("installation_id", activation.installationId).apply()
            keyField.setText(activation.keyId)
            installationField.setText(activation.installationId)
            show("Activación leída. Pulsa Iniciar seguimiento; el servidor verificará la identidad y la política.")
            return@registerForActivityResult
        }
        val ticket = try { EnrollmentTicket.parseActive(contents) }
            catch (_: Exception) {
                show("El QR no es una invitación GEOPS válida y vigente. Genera una nueva invitación en Web.")
                return@registerForActivityResult
            }
        deviceField.setText(ticket.deviceId)
        mdmField.setText(ticket.mdmDeviceId)
        invitationField.setText(ticket.invitationId)
        secretField.setText(ticket.invitationSecret)
        show("Invitación leída. Revisa el dispositivo y pulsa Reclamar invitación antes de que venza.")
    }
    private var visible = false
    private var bound = false
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val tracking = (binder as? GeopsLocationService.LocalBinder)?.service()
            if (tracking == null) { show("No se pudo conectar al servicio."); return }
            work.execute {
                val message = try { AgentRuntime.start(tracking) }
                    catch (failure: Exception) { trackingFailureMessage(failure) }
                show(message)
            }
        }
        override fun onServiceDisconnected(name: ComponentName?) { show("Servicio desconectado; estado no confirmado.") }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val saved = getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 24, 24, 24)
        }
        fun paragraph(value: String, parent: LinearLayout = content) = TextView(this).also {
            it.text = value
            it.textSize = 16f
            parent.addView(it, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = 16 })
        }
        fun field(label: String, value: String = "", parent: LinearLayout = content): EditText {
            paragraph(label, parent)
            return EditText(this).also {
                it.setSingleLine(true)
                it.setText(value)
                it.contentDescription = label
                parent.addView(it, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = 20 })
            }
        }
        fun button(label: String, action: () -> Unit) = Button(this).also {
            it.text = label
            it.setOnClickListener { action() }
            content.addView(it)
        }
        paragraph("GEOPS · inscripción supervisada de prueba")
        paragraph("La ubicación se captura durante la ventana autorizada. En dispositivos MDM vinculados, esa ventana cubre las 24 horas. Android mostrará la notificación de seguimiento.")
        val hasDevice = !saved.getString("device_id", null).isNullOrBlank()
        val hasActivation = hasDevice && !saved.getString("key_id", null).isNullOrBlank() &&
            !saved.getString("installation_id", null).isNullOrBlank()
        status = paragraph(when {
            AgentRuntime.isRunning() -> "Seguimiento iniciado en este teléfono. Consulta sesiones y ubicaciones en GEOPS Web."
            hasActivation -> "Activación guardada en este teléfono. Pulsa Iniciar seguimiento para verificar la política."
            hasDevice -> "Inscripción solicitada. Espera la confirmación en GEOPS Web y escanea el QR de activación."
            else -> "Sin inscripción local. No se captura ubicación."
        })
        button("Iniciar seguimiento") {
            if (saved.getBoolean("managed_enrolled", false))
                saved.edit().putBoolean("managed_auto_start_enabled", true).apply()
            startTracking()
        }
        paragraph("Estado del seguimiento")
        diagnostics = paragraph("Cargando diagnóstico local…").apply {
            textSize = 15f
            setLineSpacing(6f, 1f)
        }
        scannerButton = button("Escanear QR de GEOPS") {
            qrScanner.launch(ScanOptions().apply {
                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                setPrompt("Escanea la invitación o el QR de activación mostrado en GEOPS Web")
                setBeepEnabled(false)
                setBarcodeImageEnabled(false)
                setOrientationLocked(false)
            })
        }
        val manualFields = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        content.addView(manualFields)
        button("Introducir invitación manualmente") {
            manualFields.visibility = if (manualFields.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }
        deviceField = field("ID de dispositivo GEOPS", saved.getString("device_id", "") ?: "", manualFields)
        mdmField = field("ID MDM sintético", parent = manualFields)
        invitationField = field("ID de invitación", parent = manualFields)
        secretField = field("Código de inscripción de un solo uso", parent = manualFields).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        claimButton = button("Reclamar invitación") { enroll() }
        paragraph("Tras la confirmación en GEOPS Web, escanea el QR de activación y pulsa Iniciar seguimiento.")
        val manualActivation = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        content.addView(manualActivation)
        button("Introducir activación manualmente") {
            manualActivation.visibility = if (manualActivation.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }
        keyField = field("ID de clave activada", saved.getString("key_id", "") ?: "", manualActivation)
        installationField = field("ID de instalación GPS", saved.getString("installation_id", "") ?: "", manualActivation)
        Button(this).also {
            it.text = "Guardar identificadores"
            it.setOnClickListener { saveManualActivation() }
            manualActivation.addView(it)
        }
        button("Detener seguimiento") {
            work.execute {
                val message = try {
                    AgentRuntime.stopByUser(applicationContext)
                    getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE).edit()
                        .putBoolean("managed_auto_start_enabled", false).apply()
                    "Seguimiento detenido por el usuario. Para reanudar, inicia de nuevo desde esta pantalla."
                } catch (_: Exception) { "No se pudo confirmar la detención; verifica el estado del servicio." }
                show(message)
            }
        }
        button("Ver diagnóstico técnico") {
            work.execute {
                val message = try { AgentRuntime.diagnosticSummary(applicationContext) }
                    catch (_: Exception) { "Diagnóstico local no disponible. Comprueba la clave y el almacenamiento del teléfono." }
                show(message)
            }
        }
        setContentView(ScrollView(this).apply { addView(content) })
    }

    override fun onResume() {
        super.onResume()
        visible = true
        diagnosticHandler.post(diagnosticRefresh)
        val filter = IntentFilter(Intent.ACTION_APPLICATION_RESTRICTIONS_CHANGED)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(restrictionsReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(restrictionsReceiver, filter)
        restrictionsReceiverRegistered = true
        tryManagedEnrollment()
        maybeStartManagedTracking()
    }
    override fun onPause() {
        visible = false
        if (restrictionsReceiverRegistered) {
            unregisterReceiver(restrictionsReceiver)
            restrictionsReceiverRegistered = false
        }
        diagnosticHandler.removeCallbacks(diagnosticRefresh)
        super.onPause()
    }
    override fun onDestroy() {
        if (bound) unbindService(connection)
        work.shutdown()
        super.onDestroy()
    }

    private fun show(message: String) = runOnUiThread { status.text = message }

    private fun tryManagedEnrollment() {
        if (managedEnrollmentInFlight || enrollmentInFlight) return
        val saved = getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
        val restrictions = (getSystemService(Context.RESTRICTIONS_SERVICE) as? RestrictionsManager)
            ?.applicationRestrictions ?: return
        if (saved.getBoolean("managed_enrolled", false) &&
            !saved.getString("key_id", null).isNullOrBlank()) {
            if (restrictions.getBoolean(UserManager.KEY_RESTRICTIONS_PENDING, false) ||
                restrictions.getString("geops_device_id") != saved.getString("device_id", null) ||
                restrictions.getString("mdm_device_id") != saved.getString("managed_mdm_device_id", null)) {
                saved.edit().putBoolean("managed_auto_start_enabled", false).apply()
                work.execute { AgentRuntime.onUploadAuthorizationRejected() }
                show("La identidad de la configuración MDM cambió o está pendiente; GPS detenido hasta revisión administrativa.")
            }
            return
        }
        if (!saved.getString("key_id", null).isNullOrBlank()) return
        if (restrictions.getBoolean(UserManager.KEY_RESTRICTIONS_PENDING, false)) {
            show("La configuración MDM todavía está pendiente. GEOPS espera al administrador.")
            return
        }
        val required = listOf("geops_device_id", "mdm_device_id", "invitation_id",
            "invitation_secret", "expires_at")
        if (required.any { restrictions.getString(it).isNullOrBlank() }) return
        val configuredDevice = restrictions.getString("geops_device_id") ?: return
        val existingDevice = saved.getString("device_id", null)
        if (existingDevice != null && existingDevice != configuredDevice) {
            show("La configuración MDM corresponde a otro dispositivo GEOPS. Solicita revisión técnica.")
            return
        }
        val ticket = try {
            EnrollmentTicket.parseActive(org.json.JSONObject()
                .put("format", "geops-enrollment-v1")
                .put("origin", "https://geops-staging.duckdns.org")
                .put("geops_device_id", configuredDevice)
                .put("mdm_device_id", restrictions.getString("mdm_device_id"))
                .put("invitation_id", restrictions.getString("invitation_id"))
                .put("invitation_secret", restrictions.getString("invitation_secret"))
                .put("expires_at", restrictions.getString("expires_at")).toString())
        } catch (_: Exception) {
            show("La configuración de inscripción MDM no es válida o venció.")
            return
        }
        managedEnrollmentInFlight = true
        show("Inscribiendo automáticamente este dispositivo administrado…")
        work.execute {
            try {
                val signer = try { AndroidKeys.existingEnrollmentSigner(AgentRuntime.SIGNING_ALIAS) }
                    catch (_: IllegalStateException) { AndroidKeys.createSigningKey(AgentRuntime.SIGNING_ALIAS) }
                val enrollment = EnrollmentClient(HttpsEnrollmentTransport(SYNTHETIC_STAGING_BASE_URL))
                val activation = enrollment.proveManaged(ticket, enrollment.claim(ticket, signer), signer)
                saved.edit().putString("device_id", activation.deviceId)
                    .putString("key_id", activation.keyId)
                    .putString("installation_id", activation.installationId)
                    .putString("managed_mdm_device_id", ticket.mdmDeviceId)
                    .putBoolean("managed_enrolled", true)
                    .putBoolean("managed_auto_start_enabled", true).apply()
                runOnUiThread {
                    deviceField.setText(activation.deviceId)
                    keyField.setText(activation.keyId)
                    installationField.setText(activation.installationId)
                    status.text = "Inscripción MDM activada. Verificando permisos y política GPS…"
                    if (visible) maybeStartManagedTracking()
                }
            } catch (failure: Exception) {
                show(enrollmentFailureMessage(failure))
            } finally {
                runOnUiThread { managedEnrollmentInFlight = false }
            }
        }
    }

    /** A visible MDM launch can start GPS only after Android has granted every required permission. */
    private fun maybeStartManagedTracking() {
        val saved = getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
        if (!visible || !saved.getBoolean("managed_auto_start_enabled", false) ||
            saved.getString("key_id", null).isNullOrBlank() || AgentRuntime.isRunning()) return
        val precise = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val background = Build.VERSION.SDK_INT < 29 ||
            checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
        val notifications = Build.VERSION.SDK_INT < 33 ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!precise || !background || !notifications) {
            show("MDM: faltan permisos de ubicación precisa, ubicación permanente o notificaciones. El administrador debe concederlos antes de capturar GPS.")
            return
        }
        startTracking()
    }

    private fun trackingFailureMessage(failure: Exception): String = when (failure.message) {
        "assignment_downgrade" -> "Seguimiento no iniciado: el servidor entregó una versión de asignación anterior a la guardada para este dispositivo. No borres datos; revisa la política y la asignación en GEOPS Web."
        "legacy_state_identity_unknown", "state_identity_mismatch" ->
            "Seguimiento no iniciado: no se pudo verificar a qué instalación pertenece el estado cifrado. No borres datos; solicita revisión técnica."
        else -> "Seguimiento no iniciado: ${failure.message ?: "error"}"
    }

    private fun enroll() {
        val invitationId = invitationField.text.toString().trim()
        if (completedInvitationId == invitationId) {
            completionMessage?.let(::show)
            return
        }
        if (enrollmentInFlight) return
        enrollmentInFlight = true
        claimButton.isEnabled = false
        scannerButton.isEnabled = false
        val deviceId = deviceField.text.toString().trim()
        val mdmId = mdmField.text.toString().trim()
        val secret = secretField.text.toString().trim()
        show("Solicitando inscripción…")
        work.execute {
            try {
                val ticket = EnrollmentTicket.parse(org.json.JSONObject()
                    .put("format", "geops-enrollment-v1")
                    .put("origin", "https://geops-staging.duckdns.org")
                    .put("geops_device_id", deviceId).put("mdm_device_id", mdmId)
                    .put("invitation_id", invitationId).put("invitation_secret", secret)
                    .put("expires_at", Instant.now().plusSeconds(600).toString()).toString())
                val signer = try { AndroidKeys.existingEnrollmentSigner(AgentRuntime.SIGNING_ALIAS) }
                    catch (_: IllegalStateException) { AndroidKeys.createSigningKey(AgentRuntime.SIGNING_ALIAS) }
                val enrollment = EnrollmentClient(HttpsEnrollmentTransport(SYNTHETIC_STAGING_BASE_URL))
                val proof = enrollment.prove(ticket, enrollment.claim(ticket, signer), signer)
                getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE).edit()
                    .putString("device_id", deviceId).remove("key_id").remove("installation_id").apply()
                val message = "Pendiente de confirmación administrativa. Código de emparejamiento: ${proof.pairingCode}. Vence ${proof.expiresAt}."
                runOnUiThread {
                    completedInvitationId = invitationId
                    completionMessage = message
                    status.text = message
                    secretField.text.clear()
                }
            } catch (failure: Exception) {
                show(enrollmentFailureMessage(failure))
            } finally {
                runOnUiThread {
                    enrollmentInFlight = false
                    claimButton.isEnabled = true
                    scannerButton.isEnabled = true
                }
            }
        }
    }

    private fun enrollmentFailureMessage(failure: Exception): String {
        if (failure is EnrollmentHttpException) {
            if (failure.operation == "claim") return when (failure.status) {
                409 -> "La invitación no puede reclamarse por un conflicto (${failure.code ?: "estado_desconocido"}). Actualiza el dispositivo en GEOPS Web y comprueba su estado antes de generar otra invitación."
                410 -> "La invitación venció. Revócala y genera una nueva en GEOPS Web."
                401 -> "La invitación no fue validada. Comprueba que el QR corresponda a la invitación vigente del dispositivo."
                403 -> "El vínculo del dispositivo no coincide con la invitación. Revisa el registro en GEOPS Web."
                429 -> "Demasiados intentos. Espera antes de volver a intentarlo."
                else -> "No se pudo reclamar la invitación (HTTP ${failure.status}). Comprueba el estado en GEOPS Web."
            }
            return "La invitación pudo haberse reclamado, pero no se confirmó la prueba (${failure.code ?: "HTTP ${failure.status}"}). Comprueba el estado en GEOPS Web antes de volver a intentarlo."
        }
        if (failure.message == "ticket_expired")
            return "La invitación venció. Genera una nueva en GEOPS Web."
        return "No se completó la inscripción. Comprueba el estado de la invitación en GEOPS Web antes de volver a intentarlo."
    }

    private fun saveManualActivation() {
        val saved = getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
        if (saved.getString("device_id", null).isNullOrBlank() ||
            runCatching { AndroidKeys.existingEnrollmentSigner(AgentRuntime.SIGNING_ALIAS) }.isFailure) {
            show("Inscribe este teléfono antes de activarlo.")
            return
        }
        val keyId = keyField.text.toString().trim()
        val installationId = installationField.text.toString().trim()
        val id = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        if (!id.matches(keyId) || !id.matches(installationId)) {
            show("Los identificadores no son válidos. Escanea el QR de activación para evitar errores.")
            return
        }
        saved.edit().putString("key_id", keyId).putString("installation_id", installationId).apply()
        show("Identificadores guardados. Pulsa Iniciar seguimiento para validar el servidor.")
    }

    private fun startTracking() {
        if (trackingStartInFlight) return
        if (AgentRuntime.isRunning()) {
            show("El seguimiento ya está iniciado. Consulta las sesiones y ubicaciones en GEOPS Web.")
            return
        }
        val saved = getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
        val deviceId = saved.getString("device_id", "") ?: ""
        val keyId = saved.getString("key_id", "") ?: ""
        val installationId = saved.getString("installation_id", "") ?: ""
        if (deviceId.isBlank() || keyId.isBlank() || installationId.isBlank()) {
            show("Falta activar este teléfono. Escanea el QR de activación mostrado en GEOPS Web.")
            return
        }
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION), 40)
            show("Concede ubicación precisa y vuelve a pulsar iniciar.")
            return
        }
        if (Build.VERSION.SDK_INT >= 29 &&
            checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            if (Build.VERSION.SDK_INT == 29) {
                requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), 42)
                show("Concede ubicación todo el tiempo por separado y vuelve a pulsar iniciar.")
            } else {
                show("Abre permisos de GEOPS y concede ubicación todo el tiempo para inicio autónomo. Vuelve después a esta pantalla.")
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:$packageName")))
            }
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
            show("Concede notificaciones para mostrar el seguimiento y vuelve a pulsar iniciar.")
            return
        }
        trackingStartInFlight = true
        show("Validando identidad y sesión con el servidor…")
        work.execute {
            try {
                val signer = AndroidKeys.existingEnrollmentSigner(AgentRuntime.SIGNING_ALIAS)
                RefreshingSessionProvider(deviceId, keyId, signer,
                    HttpsEnrollmentTransport(SYNTHETIC_STAGING_BASE_URL)).currentToken()
                runOnUiThread {
                    if (!visible) { show("Vuelve a abrir GEOPS para iniciar desde una pantalla visible."); return@runOnUiThread }
                    try {
                        val intent = Intent(this, GeopsLocationService::class.java)
                        startForegroundService(intent)
                        bound = bindService(intent, connection, Context.BIND_AUTO_CREATE)
                        if (!bound) show("No se pudo vincular el servicio de ubicación.")
                    } catch (failure: Exception) {
                        show("Android bloqueó el inicio del servicio: ${failure.message ?: "restricción del sistema"}")
                    }
                }
            } catch (failure: Exception) {
                show("Activación no confirmada: ${failure.message ?: "error"}. Comprueba el estado del equipo en GEOPS Web.")
            } finally {
                runOnUiThread { trackingStartInFlight = false }
            }
        }
    }
}
