package com.geops.weekendpoc

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DeviceStatusTest {
    private val id = "00000000-0000-4000-8000-000000000001"
    private fun response(deviceId: String = id, environment: String = POC_ENVIRONMENT_ID,
                         capture: Boolean = false) = DeviceStatusResponse(200,
        JSONObject().put("environment_id", environment).put("device_id", deviceId)
            .put("capture_enabled", capture).toString())

    @Test fun `saved identity is distinct from server verification`() {
        assertEquals("Inscripción pendiente.", localIdentityMessage("", true, false))
        assertTrue(localIdentityMessage(id, true, true).contains("sin verificar"))
        assertTrue(localIdentityMessage(id, true, false).contains("credencial no disponible"))
        assertTrue(localIdentityMessage(id, false, true).contains("origen no coincide"))
    }

    @Test fun `read only status requires matching device and environment`() {
        assertFalse(parseDeviceStatus(response(), id).captureEnabled)
        assertTrue(parseDeviceStatus(response(capture = true), id).captureEnabled)
        for (invalid in listOf(response(deviceId = "other"), response(environment = "other"),
            DeviceStatusResponse(200, "{}"), DeviceStatusResponse(200, "not-json"))) {
            val failure = assertThrows(DeviceStatusFailure::class.java) { parseDeviceStatus(invalid, id) }
            assertTrue(failure.invalidResponse)
        }
    }

    @Test fun `authentication failure and redirects cannot confirm identity`() {
        for (status in listOf(301, 401, 403, 429, 500)) {
            val failure = assertThrows(DeviceStatusFailure::class.java) {
                parseDeviceStatus(DeviceStatusResponse(status, ""), id)
            }
            assertEquals(status, failure.status)
            assertFalse(failure.invalidResponse)
        }
    }

    @Test fun `verification uses persisted token for read only request`() {
        val syntheticToken = "A".repeat(43)
        var calls = 0
        val verifier = DeviceStatusVerifier(object : DeviceStatusTransport {
            override fun get(base: String, token: String): DeviceStatusResponse {
                calls++
                assertEquals("https://18.209.159.208", base)
                assertEquals(syntheticToken, token)
                return response()
            }
        })
        assertEquals(200, verifier.verify("https://18.209.159.208", id, syntheticToken).first)
        assertEquals(1, calls)
        assertThrows(IllegalArgumentException::class.java) {
            verifier.verify("https://18.209.159.208", id, "")
        }
        assertEquals(1, calls)
    }

    @Test fun `empty queue explains no network request`() {
        assertTrue(emptySyncMessage(0).contains("no se envió solicitud"))
        assertTrue(emptySyncMessage(2).contains("2 pendiente(s)"))
    }
}
