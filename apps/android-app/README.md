# GEOPS Android SPEC-04

Two Android product flavors share `android-agent`: `corporate` (`com.geops.corporate`) and `personal` (`com.geops.personal`). Both compile against GEOPS Staging and require an authenticated GPS v2 policy matching the APK. Corporate requires ManageEngine Managed Configurations and individual server authorization; Personal uses visible QR enrollment and work-window tracking. See [the delivery matrix and physical test plan](../../docs/operations/spec04-dual-apk-readiness.md).

SPEC-05 Wave 1 adds a local “Configuración y diagnóstico” screen to the activated Corporate flavor, including sanitized text export. Wave 2 adds a bounded encrypted diagnostic outbox and PoP upload independently of the screen. Wave 4 expands the same screen with administrative login, RBAC-gated Wave 3 ManageEngine reads, preview/request/history and explicit write-disabled messaging. Its session is held only in memory and never controls GPS. See [Wave 4 closeout](../../specs/spec-05-configuration-diagnostics/WAVE4-CLOSEOUT.md) and [controlled update gate](../../specs/spec-05-configuration-diagnostics/WAVE1-R1-LAB-PROTOCOL.md). The Wave 4 lab candidate uses versionCode 4 and versionName 1.0.3-spec05-wave4. Keep the same signer when updating an existing Corporate test installation; package and signature of the installed APK must be checked first.

## Authorized debug builds

Use the standard Android debug signer only for authorized physical tests. Keep the local debug signing home outside Git and separate from the discontinued `com.geops.mobile` app:

```powershell
New-Item -ItemType Directory -Path apps/android-app/.spec04-debug -Force | Out-Null
docker run --rm -v "${PWD}:/workspace" -v "${PWD}/apps/android-app/.spec04-debug:/root/.android" -w /workspace/apps/android-app -e GRADLE_USER_HOME=/workspace/apps/android-app/.gradle geops-android-build:local gradle assembleCorporateDebug assemblePersonalDebug --no-daemon
```

The APKs appear under `build/outputs/apk/corporate/debug/` and `build/outputs/apk/personal/debug/`. Verify each with `apksigner verify --verbose --print-certs` and `aapt dump badging` before copying to a controlled test bundle. Preserve the same debug key for updates to these test installations. Never upload a debug APK automatically to MDM or use it for production.

## Future release signing

`assembleCorporateRelease assemblePersonalRelease` produces unsigned APKs until an approved release keystore is provided through all four `GEOPS_ANDROID_RELEASE_*` variables. The existing `geops-test.jks` is excluded. Do not generate or use a release key before the separate key custody procedure is approved. Both new application IDs require new installation and enrollment; an APK for `com.geops.mobile` cannot update either flavor.
