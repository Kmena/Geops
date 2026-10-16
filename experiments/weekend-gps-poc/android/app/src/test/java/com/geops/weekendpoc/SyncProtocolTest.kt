package com.geops.weekendpoc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SyncProtocolTest {
    @Test fun acceptsOnlyPersistedIdsFromSameBatch() {
        assertEquals(setOf("a", "b"), validatedAck(setOf("a", "b"), setOf("a"), setOf("b"), "batch", "batch"))
        assertNull(validatedAck(setOf("a"), setOf("other"), emptySet(), "batch", "batch"))
        assertNull(validatedAck(setOf("a"), setOf("a"), emptySet(), "batch", "wrong"))
        assertNull(validatedAck(setOf("a"), setOf("a"), setOf("a"), "batch", "batch"))
    }
    @Test fun partialAckKeepsUnconfirmedEvent() {
        assertEquals(setOf("a"), validatedAck(setOf("a", "b"), setOf("a"), emptySet(), "batch", "batch"))
    }
}
