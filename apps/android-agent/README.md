# GEOPS Android agent — W1-C synthetic core

`src/main` contains the JVM Kotlin policy, session, health queue, AES-GCM journal, enrollment client and PoP transport. `src/test` is a synthetic executable suite (`syntheticTest`). `src/android` contains Android adapters used by the separate `apps/android-app` APK module. The weekend PoC is untouched.

With JDK 17 and Gradle, run `gradle syntheticTest` in this directory. Build the supervised test APK from `../android-app` using its README. Android packaging and signing have local evidence; emulator, instrumentation, OEM and physical-device behavior remain unverified.

## Security boundaries

- `SYNTHETIC_STAGING_BASE_URL` is `https://geops-staging.duckdns.org/`; activation must supply it explicitly. `PopHttpClient` accepts only a root HTTPS base and signs the canonical `/v1/device/*` path forwarded unchanged to Fastify, generates a new nonce per request and refuses redirects; malformed paths fail before network access. A shared Node/Kotlin vector checks the PoP bytes. An enrolled AndroidKeyStore key and short bearer must be supplied by activation code; no physical-device or live proxy test has occurred.
- `PolicyEngine` persists an authenticated snapshot only after identity/version/validity checks; boot mismatch, civil clock drift, offline expiry and UTC window end fail closed. Whole-file rollback by a privileged actor is not prevented by AES-GCM alone; a server revalidation/antirollback gate remains open.
- `EncryptedFileAgentStore` requires an **existing** AndroidKeyStore AES key. Loss of that key causes decryption failure. The store is bounded at 10,000 records / 4 MiB; overflow throws and capture must stop rather than discard pending data. Current journal uses one encrypted file and needs power-loss/restore tests on actual Android storage.
- `TrackingController` stores `STARTED` only after runtime reports visible FGS plus provider registration. A service blocked by Android produces `MISSED_START`; physical Android 12–15 behavior and OEM differences are untested. The test APK starts the service only from its visible Activity, with a user action.
- Health is sampled within authorized UTC instances even without a coordinate. The [GPS-HEALTH-001](../../specs/spec-02-android-agent-wave-1/gps-health-change-proposal.md) message shape has a synthetic backend and includes boot/anchor monotonic evidence. The test APK explicitly enables health upload in its runtime; operational security/privacy approval remains pending. Server-only `NO_COMMUNICATION` inference is outside this client.

No user-facing policy editing is present. No location is captured outside `onLocation` after two window checks. Sending stored in-window events after shift is separate from capture and still requires current device identity.
