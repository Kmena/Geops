# GEOPS Android agent — W1-C synthetic core

`src/main` contains the JVM Kotlin policy, session, health queue, AES-GCM journal and PoP transport. `src/test` is a synthetic executable suite (`syntheticTest`). `src/android` contains **unwired** Android adapters and a manifest fragment; no APK, receiver, boot automation or production device action is built here. The weekend PoC is untouched.

With JDK 17 and Gradle, run `gradle syntheticTest` in this directory. In this workspace the core and tests were compiled with the cached Kotlin 2.3.0 compiler on JRE 8; the Android adapters were separately compiled against the cached `android.jar`. No Gradle/AGP packaging or instrumentation was performed.

## Security boundaries

- `PopHttpClient` signs exact SPEC-00 request bytes and rejects redirects; an enrolled AndroidKeyStore key and short bearer must be supplied by activation code. The backend must validate PoP and authorization. The current API does not yet expose device GPS/health ingestion.
- `PolicyEngine` persists an authenticated snapshot only after identity/version/validity checks; boot mismatch, civil clock drift, offline expiry and UTC window end fail closed. Whole-file rollback by a privileged actor is not prevented by AES-GCM alone; a server revalidation/antirollback gate remains open.
- `EncryptedFileAgentStore` requires an **existing** AndroidKeyStore AES key. Loss of that key causes decryption failure. The store is bounded at 10,000 records / 4 MiB; overflow throws and capture must stop rather than discard pending data. Current journal uses one encrypted file and needs power-loss/restore tests on actual Android storage.
- `TrackingController` stores `STARTED` only after runtime reports visible FGS plus provider registration. A service blocked by Android produces `MISSED_START`; physical Android 12–15 behavior and OEM differences are untested. The service must be started from a legal visible flow and wired to this controller before any APK can be released.
- Health is sampled within authorized UTC instances even without a coordinate. The [GPS-HEALTH-001](../../specs/spec-02-android-agent-wave-1/gps-health-change-proposal.md) message shape now has a synthetic backend and includes boot/anchor monotonic evidence. The transport still refuses health upload by default until product integration and security/privacy gates close. Server-only `NO_COMMUNICATION` inference is outside this client.

No user-facing policy editing is present. No location is captured outside `onLocation` after two window checks. Sending stored in-window events after shift is separate from capture and still requires current device identity.
