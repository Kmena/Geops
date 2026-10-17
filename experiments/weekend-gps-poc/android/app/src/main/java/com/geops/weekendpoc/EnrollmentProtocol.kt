package com.geops.weekendpoc

import org.json.JSONObject
import java.net.URI
import java.util.concurrent.atomic.AtomicInteger

internal const val POC_ENVIRONMENT_ID = "weekend-gps-poc-v1"
private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
private val SECRET_PATTERN = Regex("^[A-Za-z0-9_-]{43}$")

internal data class Invitation(
    val apiBase: String,
    val environmentId: String,
    val invitationId: String,
    val invitationSecret: String
) {
    fun requestBody(): String = JSONObject()
        .put("environment_id", environmentId)
        .put("invitation_id", invitationId)
        .put("invitation_secret", invitationSecret).toString()
}

internal data class EnrolledDevice(val environmentId: String, val deviceId: String, val token: String)
internal data class EnrollmentHttpResponse(val status: Int, val body: String)
internal enum class EnrollmentFailureKind {
    INVALID_QR, ORIGIN_MISMATCH, INVITATION_EXPIRED, INVITATION_USED,
    CONNECTION, TLS, HTTP, INVALID_RESPONSE, LOCAL_STORAGE, INTERNAL
}
internal class EnrollmentFailure(
    val kind: EnrollmentFailureKind,
    val httpStatus: Int? = null
) : Exception()

internal enum class EnrollmentEvent {
    QR_RECOGNIZED, QR_JSON_VALID, QR_JSON_INVALID, QR_ORIGIN_MISMATCH,
    HTTP_STARTED, HTTP_RESPONSE, TLS_ERROR, CONNECTION_ERROR, ENROLLMENT_CONFIRMED
}

internal class EnrollmentAttemptGate {
    private val state = AtomicInteger(0)
    fun begin(): Boolean = state.compareAndSet(0, 1)
    fun acceptResult(): Boolean = state.compareAndSet(1, 2)
    fun isScanning(): Boolean = state.get() == 1
    fun finish() { state.set(0) }
}

internal fun canonicalOrigin(value: String): String {
    val uri = URI(value)
    if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.rawUserInfo != null ||
        uri.rawQuery != null || uri.rawFragment != null || uri.rawPath !in listOf("", "/", null) ||
        uri.port !in listOf(-1, 443)) throw IllegalArgumentException()
    return "https://" + uri.host.lowercase()
}

internal fun parseInvitation(raw: String, expectedOrigin: String): Invitation {
    try {
        if (raw.length > 4096) throw IllegalArgumentException()
        val qr = JSONObject(raw)
        val keys = qr.keys().asSequence().toSet()
        if (keys != setOf("api_base", "environment_id", "invitation_id", "invitation_secret"))
            throw IllegalArgumentException()
        val base = qr.opt("api_base") as? String ?: throw IllegalArgumentException()
        val env = qr.opt("environment_id") as? String ?: throw IllegalArgumentException()
        val id = qr.opt("invitation_id") as? String ?: throw IllegalArgumentException()
        val secret = qr.opt("invitation_secret") as? String ?: throw IllegalArgumentException()
        val normalizedBase = canonicalOrigin(base)
        if (env != POC_ENVIRONMENT_ID || !UUID_PATTERN.matches(id) || !SECRET_PATTERN.matches(secret))
            throw IllegalArgumentException()
        if (normalizedBase != canonicalOrigin(expectedOrigin))
            throw EnrollmentFailure(EnrollmentFailureKind.ORIGIN_MISMATCH)
        return Invitation(normalizedBase, env, id, secret)
    } catch (error: EnrollmentFailure) {
        throw error
    } catch (_: Exception) {
        throw EnrollmentFailure(EnrollmentFailureKind.INVALID_QR)
    }
}
internal fun parseEnrollmentResponse(response: EnrollmentHttpResponse): EnrolledDevice {
    val status = response.status
    if (status != 201) {
        val code = try { JSONObject(response.body).optString("error") } catch (_: Exception) { "" }
        val kind = when {
            status == 410 && code == "invitation_expired" -> EnrollmentFailureKind.INVITATION_EXPIRED
            status == 409 && code == "invitation_used" -> EnrollmentFailureKind.INVITATION_USED
            status == 400 && code == "invalid_enrollment" -> EnrollmentFailureKind.INVALID_QR
            status == 401 && code == "invalid_invitation" -> EnrollmentFailureKind.INVALID_QR
            else -> EnrollmentFailureKind.HTTP
        }
        throw EnrollmentFailure(kind, status)
    }
    try {
        val body = JSONObject(response.body)
        val env = body.opt("environment_id") as? String ?: throw IllegalArgumentException()
        val id = body.opt("device_id") as? String ?: throw IllegalArgumentException()
        val token = body.opt("device_token") as? String ?: throw IllegalArgumentException()
        if (env != POC_ENVIRONMENT_ID || !UUID_PATTERN.matches(id) || !SECRET_PATTERN.matches(token))
            throw IllegalArgumentException()
        return EnrolledDevice(env, id, token)
    } catch (_: Exception) {
        throw EnrollmentFailure(EnrollmentFailureKind.INVALID_RESPONSE, status)
    }
}
