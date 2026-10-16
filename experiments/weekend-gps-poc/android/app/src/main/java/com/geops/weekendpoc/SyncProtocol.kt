package com.geops.weekendpoc

internal fun validatedAck(
    sent: Set<String>,
    accepted: Set<String>,
    duplicate: Set<String>,
    requestBatchId: String,
    responseBatchId: String
): Set<String>? {
    if (requestBatchId != responseBatchId || accepted.intersect(duplicate).isNotEmpty()) return null
    val acknowledged = accepted + duplicate
    if (!sent.containsAll(acknowledged)) return null
    return acknowledged
}
