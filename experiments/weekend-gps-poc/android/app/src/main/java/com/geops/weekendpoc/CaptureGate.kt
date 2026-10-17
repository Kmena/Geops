package com.geops.weekendpoc

internal fun captureReady(enabled: Boolean, deviceId: String, apiBase: String,
                          expectedOrigin: String, tokenAvailable: Boolean): Boolean =
    enabled && deviceId.isNotBlank() && tokenAvailable &&
        runCatching { canonicalOrigin(apiBase) == canonicalOrigin(expectedOrigin) }.getOrDefault(false)
