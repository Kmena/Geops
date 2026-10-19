package com.geops.mobile

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.geops.agent.AndroidKeys
import com.geops.agent.EnrollmentClient
import com.geops.agent.EnrollmentTicket
import com.geops.agent.GeopsLocationService
import com.geops.agent.HttpsEnrollmentTransport
import com.geops.agent.RefreshingSessionProvider
import com.geops.agent.SYNTHETIC_STAGING_BASE_URL
import java.time.Instant
import java.util.concurrent.Executors

/** Visible supervised enrollment and diagnostic UI; policy values are read-only from the server. */
class EnrollmentActivity : Activity() {
    private val work = Executors.newSingleThreadExecutor()
    private lateinit var deviceField: EditText
    private lateinit var mdmField: EditText
    private lateinit var invitationField: EditText
    private lateinit var secretField: EditText
    private lateinit var keyField: EditText
    private lateinit var installationField: EditText
    private lateinit var status: TextView
    private var visible = false
    private var bound = false
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val tracking = (binder as? GeopsLocationService.LocalBinder)?.service()
            if (tracking == null) { show("No se pudo conectar al servicio."); return }
            work.execute {
                val message = try { AgentRuntime.start(tracking) }
                    catch (failure: Exception) { "Seguimiento no iniciado: ${failure.message ?: "error"}" }
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
        fun paragraph(value: String) = TextView(this).also {
            it.text = value
            it.textSize = 16f
            content.addView(it, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = 16 })
        }
        fun field(label: String, value: String = ""): EditText {
            paragraph(label)
            return EditText(this).also {
                it.setSingleLine(true)
                it.setText(value)
                it.contentDescription = label
                content.addView(it, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = 20 })
            }
        }
        fun button(label: String, action: () -> Unit) = Button(this).also {
            it.text = label
            it.setOnClickListener { action() }
            content.addView(it)
        }
        paragraph("GEOPS · inscripción supervisada de prueba")
        paragraph("La ubicación solo se inicia durante una ventana autorizada desde esta pantalla visible. Android mostrará la notificación de seguimiento.")
        deviceField = field("ID de dispositivo GEOPS", saved.getString("device_id", "") ?: "")
        mdmField = field("ID MDM sintético")
        invitationField = field("ID de invitación")
        secretField = field("Código de inscripción de un solo uso")
        button("Reclamar invitación") { enroll() }
        paragraph("Tras la confirmación en GEOPS Web, introduce los identificadores de activación. No son credenciales.")
        keyField = field("ID de clave activada", saved.getString("key_id", "") ?: "")
        installationField = field("ID de instalación GPS", saved.getString("installation_id", "") ?: "")
        button("Consultar política e iniciar seguimiento autorizado") { startTracking() }
        status = paragraph("Sin inscripción confirmada. No se captura ubicación.")
        setContentView(ScrollView(this).apply { addView(content) })
    }

    override fun onResume() { super.onResume(); visible = true }
    override fun onPause() { visible = false; super.onPause() }
    override fun onDestroy() {
        if (bound) unbindService(connection)
        work.shutdown()
        super.onDestroy()
    }

    private fun show(message: String) = runOnUiThread { status.text = message }

    private fun enroll() {
        val deviceId = deviceField.text.toString().trim()
        val mdmId = mdmField.text.toString().trim()
        val invitationId = invitationField.text.toString().trim()
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
                    .putString("device_id", deviceId).apply()
                show("Pendiente de confirmación administrativa. Código de emparejamiento: ${proof.pairingCode}. Vence ${proof.expiresAt}.")
                runOnUiThread { secretField.text.clear() }
            } catch (failure: Exception) {
                show("Inscripción no completada: ${failure.message ?: "error"}. Verifica la invitación y vuelve a intentarlo.")
            }
        }
    }

    private fun startTracking() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION), 40)
            show("Concede ubicación precisa y vuelve a pulsar iniciar.")
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
            show("Concede notificaciones para mostrar el seguimiento y vuelve a pulsar iniciar.")
            return
        }
        val deviceId = deviceField.text.toString().trim()
        val keyId = keyField.text.toString().trim()
        val installationId = installationField.text.toString().trim()
        show("Validando identidad y sesión con el servidor…")
        work.execute {
            try {
                val signer = AndroidKeys.existingEnrollmentSigner(AgentRuntime.SIGNING_ALIAS)
                RefreshingSessionProvider(deviceId, keyId, signer,
                    HttpsEnrollmentTransport(SYNTHETIC_STAGING_BASE_URL)).currentToken()
                val saved = getSharedPreferences("geops_agent_identity", Context.MODE_PRIVATE)
                saved.edit().putString("device_id", deviceId).putString("key_id", keyId)
                    .putString("installation_id", installationId).apply()
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
                show("Activación no confirmada: ${failure.message ?: "error"}. Revisa los identificadores en GEOPS Web.")
            }
        }
    }
}
