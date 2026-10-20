# GEOPS Android test APK — W1-E2

This module packages the existing `android-agent` policy, session, PoP and encrypted-queue code. It is a supervised test build for the synthetic Staging origin `https://geops-staging.duckdns.org`. It has not been installed or tested on a physical phone.

The user scans the invitation QR displayed by GEOPS Web in portrait orientation or enters its values manually, reviews the device identity and taps **Reclamar invitación** once. The camera permission is requested when the scanner opens; only GEOPS Staging tickets with the expected format, origin and unexpired timestamp fill the fields. The scanner does not save a barcode image, and the app does not log the QR content. The claim button is disabled while the request runs and a repeated tap after success preserves the pairing code without sending another claim. A conflict response displays only an allowlisted code; check the invitation and claim states in Web before issuing a replacement. After comparing the pairing code with the administrator, the administrator confirms the claim and activates the GPS installation. The user then enters the resulting key and installation IDs. Starting tracking requires a visible Activity action, location permissions and a valid server policy. The foreground service displays a notification. No boot receiver or hidden restart is present; Android/OEM startup behavior still needs physical validation. The Android UI does not edit policy values.

## Local build and signing

Build with JDK 17, Android SDK 36 and Gradle 8.14, or use `Dockerfile.build` from the repository root. The signing variables are `GEOPS_ANDROID_KEYSTORE`, `GEOPS_ANDROID_STORE_PASSWORD` and `GEOPS_ANDROID_KEY_PASSWORD`; the configured key alias is `geops-test`. Store the keystore and passwords outside version control. `.local-signing/`, `.gradle/`, `build/` and `*.apk` are ignored by Git.

```powershell
docker build -t geops-android-build:local -f apps/android-app/Dockerfile.build apps/android-app
docker run --rm --env-file apps/android-app/.local-signing/signing.env -v "${PWD}:/workspace" -w /workspace/apps/android-app -e GRADLE_USER_HOME=/workspace/apps/android-app/.gradle geops-android-build:local gradle assembleRelease --no-daemon
```

The output is `build/outputs/apk/release/GeopsAndroid-release.apk`. Verify it with Android SDK `apksigner verify --verbose --print-certs`. Preserve an encrypted, access-controlled backup of the **same** keystore, alias and passwords outside the repository, and record the signing certificate SHA-256. Android package updates require the original signing identity; generating a new key does not update an installed APK. Rotate through a separately reviewed Android signing procedure if the key is lost or compromised.

Do not install this APK or enable real GPS without the separate supervised physical-test authorization. Do not publish the local test keystore, APK or invitation secret.
