package com.geops.agent

import java.nio.file.Files
import java.nio.file.Paths
import org.json.JSONObject

/** Parses the exact synthetic HTTP response emitted by gps-config.integration.mjs. */
fun main(args: Array<String>) {
    require(args.size == 1) { "snapshot_path_required" }
    val raw = String(Files.readAllBytes(Paths.get(args[0])), Charsets.UTF_8)
    val wire = JSONObject(raw)
    val identity = Identity(wire.getString("device_id"), wire.getString("installation_id"))
    val snapshot = ConfigParser.parse(raw, identity)
    check(snapshot.active && snapshot.policy?.revision == 1)
    check(snapshot.windows.isNotEmpty() && snapshot.policy.healthIntervalS == 300)
    check(snapshot.assignmentVersion > 0 && snapshot.windows.all { it.startMs < it.endMs })
    println("PASS Kotlin parsed authenticated PostgreSQL config snapshot")
}
