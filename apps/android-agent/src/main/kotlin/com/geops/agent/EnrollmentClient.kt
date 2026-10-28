package com.geops.agent

import java.net.URL
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

/** This ticket is an enrollment secret. Keep it in memory and discard after proof. */
data class EnrollmentTicket(
    val deviceId: String, val mdmDeviceId: String, val invitationId: String,
    val invitationSecret: String, val expiresAt: Instant
) {
    companion object {
        fun parse(raw: String, expectedOrigin: String = "https://geops-staging.duckdns.org"): EnrollmentTicket {
            require(raw.length <= 4096) { "ticket_too_large" }
            val value = JSONObject(raw)
            require(value.keys().asSequence().toSet() == setOf("format", "origin", "geops_device_id", "mdm_device_id",
                "invitation_id", "invitation_secret", "expires_at")) { "ticket_fields" }
            require(value.getString("format") == "geops-enrollment-v1" &&
                value.getString("origin") == expectedOrigin) { "ticket_origin" }
            val deviceId = value.getString("geops_device_id")
            val invitationId = value.getString("invitation_id")
            require(uuid(deviceId) && uuid(invitationId)) { "ticket_id" }
            val mdmId = value.getString("mdm_device_id")
            require(mdmId.isNotBlank() && mdmId.length <= 256) { "ticket_mdm_id" }
            val secret = value.getString("invitation_secret")
            require(Base64.getUrlDecoder().decode(secret).size == 32 &&
                Base64.getUrlEncoder().withoutPadding().encodeToString(Base64.getUrlDecoder().decode(secret)) == secret)
                { "ticket_secret" }
            return EnrollmentTicket(deviceId, mdmId, invitationId, secret,
                Instant.parse(value.getString("expires_at")))
        }

        fun parseActive(raw: String, now: Instant = Instant.now()): EnrollmentTicket =
            parse(raw).also { require(it.expiresAt.isAfter(now)) { "ticket_expired" } }
    }
}

/** Public identifiers delivered by the administrator after supervised confirmation.
 * Possession of this QR grants nothing: the server still requires the enrolled private key. */
data class ActivationTicket(val deviceId: String, val keyId: String, val installationId: String,
    val expiresAt: Instant) {
    companion object {
        fun parse(raw: String, expectedOrigin: String = "https://geops-staging.duckdns.org"): ActivationTicket {
            require(raw.length <= 1024) { "activation_too_large" }
            val value = JSONObject(raw)
            require(value.keys().asSequence().toSet() == setOf("format", "origin", "geops_device_id",
                "key_id", "installation_id", "expires_at")) { "activation_fields" }
            require(value.getString("format") == "geops-activation-v1" &&
                value.getString("origin") == expectedOrigin) { "activation_origin" }
            val deviceId = value.getString("geops_device_id")
            val keyId = value.getString("key_id")
            val installationId = value.getString("installation_id")
            require(uuid(deviceId) && uuid(keyId) && uuid(installationId)) { "activation_id" }
            return ActivationTicket(deviceId, keyId, installationId, Instant.parse(value.getString("expires_at")))
        }
        fun parseActive(raw: String, now: Instant = Instant.now()): ActivationTicket =
            parse(raw).also { require(it.expiresAt.isAfter(now)) { "activation_expired" } }
    }
}

interface EnrollmentSigner {
    val publicSpki: ByteArray
    fun sign(message: ByteArray): ByteArray
}

interface EnrollmentTransport { fun post(path: String, body: String): HttpResult }

/** HTTPS only, canonical device paths, no redirect or custom trust manager. */
class HttpsEnrollmentTransport(baseUrl: String) : EnrollmentTransport {
    private val origin = URL(baseUrl)
    init {
        require(origin.protocol == "https" && origin.query == null && origin.ref == null &&
            origin.userInfo == null && (origin.path == "" || origin.path == "/") && origin.host.isNotBlank())
    }
    override fun post(path: String, body: String): HttpResult {
        require(path.matches(Regex("^/v1/device/(enrollment/claims|enrollment/claims/[0-9a-f-]{36}/proof|sessions/challenge|sessions)$")))
        val target = URL(origin, path)
        require(target.host == origin.host && target.port == origin.port && target.path == path)
        val connection = target.openConnection() as HttpsURLConnection
        connection.instanceFollowRedirects = false
        connection.requestMethod = "POST"
        connection.connectTimeout = 10_000
        connection.readTimeout = 20_000
        connection.setRequestProperty("Content-Type", "application/json")
        connection.setRequestProperty("Cache-Control", "no-store")
        connection.doOutput = true
        try {
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val bytes = stream?.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (output.size() <= 131_072) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    output.write(buffer, 0, read)
                }
                output.toByteArray()
            } ?: byteArrayOf()
            require(bytes.size <= 131_072) { "enrollment_response_too_large" }
            return HttpResult(code, String(bytes, Charsets.UTF_8),
                connection.getHeaderField("Retry-After")?.toIntOrNull())
        } finally { connection.disconnect() }
    }
}

data class EnrollmentClaim(val claimId: String, val challengeId: String, val challenge: String,
    val clientNonce: String, val publicSpki: ByteArray)
data class EnrollmentProof(val pairingCode: String, val expiresAt: Instant)

/** Only an allowlisted server code is retained; the response body is never shown or logged. */
class EnrollmentHttpException(val operation: String, val status: Int, val code: String?) :
    IllegalStateException("${operation}_http_$status")

private fun enrollmentHttpError(operation: String, result: HttpResult): EnrollmentHttpException {
    val allowed = setOf("invitation_consumed", "device_state", "invitation_expired",
        "invalid_invitation", "binding_mismatch", "claim_unavailable", "claim_consumed",
        "claim_expired", "challenge_consumed")
    val code = runCatching { JSONObject(result.body).optString("code") }.getOrNull()
        ?.takeIf { it in allowed }
    return EnrollmentHttpException(operation, result.status, code)
}

class EnrollmentClient(private val transport: EnrollmentTransport,
    private val clock: () -> Instant = { Instant.now() }) {
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val random = SecureRandom()

    fun claim(ticket: EnrollmentTicket, signer: EnrollmentSigner): EnrollmentClaim {
        require(clock().isBefore(ticket.expiresAt)) { "ticket_expired" }
        val nonce = ByteArray(16).also(random::nextBytes)
        val clientNonce = encoder.encodeToString(nonce)
        val body = JSONObject().put("invitation_id", ticket.invitationId)
            .put("invitation_secret", ticket.invitationSecret)
            .put("geops_device_id", ticket.deviceId).put("mdm_device_id", ticket.mdmDeviceId)
            .put("public_key_spki", encoder.encodeToString(signer.publicSpki))
            .put("client_nonce", clientNonce).toString()
        val result = transport.post("/v1/device/enrollment/claims", body)
        if (result.status != 201) throw enrollmentHttpError("claim", result)
        val response = JSONObject(result.body)
        val id = response.getString("claim_id")
        val challengeId = response.getString("challenge_id")
        require(uuid(id) && uuid(challengeId)) { "claim_response_id" }
        val challenge = response.getString("challenge")
        require(Base64.getUrlDecoder().decode(challenge).size == 32) { "claim_challenge" }
        return EnrollmentClaim(id, challengeId, challenge, clientNonce, signer.publicSpki.copyOf())
    }

    fun prove(ticket: EnrollmentTicket, claim: EnrollmentClaim, signer: EnrollmentSigner): EnrollmentProof {
        require(MessageDigest.isEqual(claim.publicSpki, signer.publicSpki)) { "key_changed" }
        val fingerprint = encoder.encodeToString(MessageDigest.getInstance("SHA-256").digest(claim.publicSpki))
        val bytes = listOf("GEOPS-ENROLL-V1", claim.claimId, claim.challengeId, claim.challenge,
            ticket.deviceId, ticket.mdmDeviceId, fingerprint, claim.clientNonce)
            .joinToString("\n").toByteArray(Charsets.UTF_8)
        val body = JSONObject().put("challenge_id", claim.challengeId)
            .put("signature", encoder.encodeToString(signer.sign(bytes))).toString()
        val result = transport.post("/v1/device/enrollment/claims/${claim.claimId}/proof", body)
        if (result.status != 200) throw enrollmentHttpError("proof", result)
        val response = JSONObject(result.body)
        require(response.getString("status") == "PENDING_CONFIRMATION") { "proof_state" }
        val code = response.getString("pairing_code")
        require(code.matches(Regex("[0-9]{8}"))) { "proof_code" }
        return EnrollmentProof(code, Instant.parse(response.getString("expires_at")))
    }

    /** Managed configuration replaces the later administrator confirmation only
     * after the server verifies the pre-linked MDM device and consumes the secret. */
    fun proveManaged(ticket: EnrollmentTicket, claim: EnrollmentClaim,
        signer: EnrollmentSigner): ActivationTicket {
        require(MessageDigest.isEqual(claim.publicSpki, signer.publicSpki)) { "key_changed" }
        val fingerprint = encoder.encodeToString(MessageDigest.getInstance("SHA-256").digest(claim.publicSpki))
        val bytes = listOf("GEOPS-ENROLL-V1", claim.claimId, claim.challengeId, claim.challenge,
            ticket.deviceId, ticket.mdmDeviceId, fingerprint, claim.clientNonce)
            .joinToString("\n").toByteArray(Charsets.UTF_8)
        val body = JSONObject().put("challenge_id", claim.challengeId)
            .put("signature", encoder.encodeToString(signer.sign(bytes))).toString()
        val result = transport.post("/v1/device/enrollment/claims/${claim.claimId}/proof", body)
        if (result.status != 200) throw enrollmentHttpError("proof", result)
        val response = JSONObject(result.body)
        require(response.keys().asSequence().toSet() == setOf("status", "key_id", "installation_id") &&
            response.getString("status") == "ACTIVE") { "managed_proof_state" }
        val keyId = response.getString("key_id")
        val installationId = response.getString("installation_id")
        require(uuid(keyId) && uuid(installationId)) { "managed_activation_id" }
        return ActivationTicket(ticket.deviceId, keyId, installationId, ticket.expiresAt)
    }
}

/** A short bearer is held only in memory; on expiry a new signed session is requested. */
class RefreshingSessionProvider(private val deviceId: String, private val keyId: String,
    private val signer: EnrollmentSigner, private val transport: EnrollmentTransport,
    private val clock: () -> Instant = { Instant.now() }) : SessionTokenProvider {
    private var token: String? = null
    private var expiresAt: Instant = Instant.EPOCH
    @Synchronized override fun currentToken(): String {
        if (token != null && clock().plusSeconds(30).isBefore(expiresAt)) return token!!
        require(uuid(deviceId) && uuid(keyId)) { "session_identity" }
        val challengeResponse = transport.post("/v1/device/sessions/challenge",
            JSONObject().put("geops_device_id", deviceId).put("key_id", keyId).toString())
        require(challengeResponse.status == 200) { "session_challenge_http_${challengeResponse.status}" }
        val challenge = JSONObject(challengeResponse.body)
        val challengeId = challenge.getString("challenge_id")
        val value = challenge.getString("challenge")
        require(uuid(challengeId) && Base64.getUrlDecoder().decode(value).size == 32) { "session_challenge" }
        val bytes = listOf("GEOPS-SESSION-V1", challengeId, value, keyId, deviceId)
            .joinToString("\n").toByteArray(Charsets.UTF_8)
        val signed = transport.post("/v1/device/sessions", JSONObject()
            .put("geops_device_id", deviceId).put("key_id", keyId)
            .put("challenge_id", challengeId)
            .put("signature", Base64.getUrlEncoder().withoutPadding().encodeToString(signer.sign(bytes)))
            .toString())
        require(signed.status == 201) { "session_http_${signed.status}" }
        val result = JSONObject(signed.body)
        val next = result.getString("access_token")
        require(Base64.getUrlDecoder().decode(next).size == 32 && result.getString("key_id") == keyId)
            { "session_response" }
        expiresAt = Instant.parse(result.getString("expires_at"))
        require(expiresAt.isAfter(clock())) { "session_expired" }
        token = next
        return next
    }
}
