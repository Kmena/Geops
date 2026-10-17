package com.geops.weekendpoc

import org.junit.Assert.*
import org.junit.Test

class CaptureGateTest {
    private val origin = "https://18.209.159.208"
    private val device = "00000000-0000-4000-8000-000000000001"

    @Test fun `capture requires explicit build flag and readable local identity`() {
        assertTrue(captureReady(true, device, origin, origin, true))
        assertFalse(captureReady(false, device, origin, origin, true))
        assertFalse(captureReady(true, "", origin, origin, true))
        assertFalse(captureReady(true, device, origin, origin, false))
        assertFalse(captureReady(true, device, "https://gps-poc.example.invalid", origin, true))
        assertFalse(captureReady(true, device, "http://18.209.159.208", origin, true))
    }
}
