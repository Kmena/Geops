package com.geops.weekendpoc

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import javax.net.ssl.SSLHandshakeException

class EnrollmentProtocolTest {
    private val origin = "https://18.209.159.208"
    private val id = "00000000-0000-4000-8000-000000000001"
    private val token = "A".repeat(43)
    private fun qr(base: String = origin, env: String = POC_ENVIRONMENT_ID, secret: String = token): String =
        JSONObject().put("api_base", base).put("environment_id", env)
            .put("invitation_id", id).put("invitation_secret", secret).toString()
    private fun response(): EnrollmentHttpResponse = EnrollmentHttpResponse(201,
        JSONObject().put("environment_id", POC_ENVIRONMENT_ID).put("device_id", id)
            .put("device_token", token).toString())
    private fun failure(block: () -> Unit): EnrollmentFailure =
        try { block(); fail("Expected enrollment failure"); throw AssertionError() }
        catch (error: EnrollmentFailure) { error }

    @Test fun `QR parse normalizes only root HTTPS origin`() {
        val invitation = parseInvitation(qr("$origin/"), "$origin:443")
        assertEquals(origin, invitation.apiBase)
        assertEquals(id, invitation.invitationId)
        assertEquals(setOf("environment_id", "invitation_id", "invitation_secret"),
            JSONObject(invitation.requestBody()).keys().asSequence().toSet())
        assertEquals(EnrollmentFailureKind.ORIGIN_MISMATCH,
            failure { parseInvitation(qr(), "https://gps-poc.example.invalid") }.kind)
        for (base in listOf("http://18.209.159.208", "$origin/api", "$origin:8443", "https://user@18.209.159.208", "$origin?x=1"))
            assertEquals(EnrollmentFailureKind.INVALID_QR, failure { parseInvitation(qr(base), origin) }.kind)
    }

    @Test fun `QR rejects malformed JSON and invalid fields without transport`() {
        for (raw in listOf("not-json", "[]", qr(env = "wrong"), qr(secret = "short"),
            JSONObject(qr()).put("extra", true).toString(),
            JSONObject(qr()).put("invitation_id", "bad").toString()))
            assertEquals(EnrollmentFailureKind.INVALID_QR, failure { parseInvitation(raw, origin) }.kind)
    }

    @Test fun `HTTP statuses are classified and response must confirm identity`() {
        assertEquals(id, parseEnrollmentResponse(response()).deviceId)
        val cases = listOf(
            Triple(410, "invitation_expired", EnrollmentFailureKind.INVITATION_EXPIRED),
            Triple(409, "invitation_used", EnrollmentFailureKind.INVITATION_USED),
            Triple(400, "invalid_enrollment", EnrollmentFailureKind.INVALID_QR),
            Triple(401, "invalid_invitation", EnrollmentFailureKind.INVALID_QR),
            Triple(429, "rate_limited", EnrollmentFailureKind.HTTP),
            Triple(302, "", EnrollmentFailureKind.HTTP),
            Triple(500, "internal_error", EnrollmentFailureKind.HTTP)
        )
        for ((status, code, kind) in cases) {
            val result = failure { parseEnrollmentResponse(EnrollmentHttpResponse(status,
                JSONObject().put("error", code).toString())) }
            assertEquals(kind, result.kind)
            assertEquals(status, result.httpStatus)
        }
        assertEquals(EnrollmentFailureKind.INVALID_RESPONSE,
            failure { parseEnrollmentResponse(EnrollmentHttpResponse(201, "{}")) }.kind)
        assertEquals(EnrollmentFailureKind.INVALID_RESPONSE,
            failure { parseEnrollmentResponse(EnrollmentHttpResponse(201,
                JSONObject(response().body).put("device_token", "bad").toString())) }.kind)
    }

    @Test fun `only valid server confirmation persists identity and events contain no secret`() {
        val events = mutableListOf<Pair<EnrollmentEvent, Int?>>()
        var saved = 0
        val coordinator = EnrollmentCoordinator(object : EnrollmentTransport {
            override fun post(invitation: Invitation): EnrollmentHttpResponse {
                assertEquals(origin, invitation.apiBase)
                return response()
            }
        }, { _, _ -> saved++ }, { event, status -> events.add(event to status) })
        coordinator.enroll(qr(), origin)
        assertEquals(1, saved)
        assertEquals(EnrollmentEvent.ENROLLMENT_CONFIRMED, events.last().first)
        assertFalse(events.toString().contains(token))
        val invalid = EnrollmentCoordinator(object : EnrollmentTransport {
            override fun post(invitation: Invitation) = EnrollmentHttpResponse(201, "{}")
        }, { _, _ -> saved++ }, { _, _ -> })
        assertEquals(EnrollmentFailureKind.INVALID_RESPONSE,
            failure { invalid.enroll(qr(), origin) }.kind)
        assertEquals(1, saved)
    }

    @Test fun `connection TLS and local storage failures never report confirmed enrollment`() {
        for ((error, kind) in listOf(
            IOException("synthetic connection") to EnrollmentFailureKind.CONNECTION,
            SSLHandshakeException("synthetic TLS") to EnrollmentFailureKind.TLS
        )) {
            val events = mutableListOf<EnrollmentEvent>()
            val coordinator = EnrollmentCoordinator(object : EnrollmentTransport {
                override fun post(invitation: Invitation): EnrollmentHttpResponse { throw error }
            }, { _, _ -> fail("Must not save") }, { event, _ -> events.add(event) })
            assertEquals(kind, failure { coordinator.enroll(qr(), origin) }.kind)
            assertFalse(events.contains(EnrollmentEvent.ENROLLMENT_CONFIRMED))
        }
        val events = mutableListOf<EnrollmentEvent>()
        val failedSave = EnrollmentCoordinator(object : EnrollmentTransport {
            override fun post(invitation: Invitation) = response()
        }, { _, _ -> throw IllegalStateException("synthetic write") }, { event, _ -> events.add(event) })
        assertEquals(EnrollmentFailureKind.LOCAL_STORAGE,
            failure { failedSave.enroll(qr(), origin) }.kind)
        assertFalse(events.contains(EnrollmentEvent.ENROLLMENT_CONFIRMED))
    }

    @Test fun `attempt gate accepts one scan result and one request`() {
        val gate = EnrollmentAttemptGate()
        assertTrue(gate.begin())
        assertFalse(gate.begin())
        assertTrue(gate.acceptResult())
        assertFalse(gate.acceptResult())
        gate.finish()
        assertTrue(gate.begin())
    }
}
