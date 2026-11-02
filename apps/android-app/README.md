# GEOPS Android SPEC-04

Two Android product flavors share `android-agent`: `corporate` (`com.geops.corporate`) and `personal` (`com.geops.personal`). Both compile against GEOPS Staging and require an authenticated GPS v2 policy matching the APK. Corporate requires ManageEngine Managed Configurations and individual server authorization; Personal uses visible QR enrollment and work-window tracking. See [the delivery matrix and physical test plan](../../docs/operations/spec04-dual-apk-readiness.md).

## Authorized debug builds

Use the standard Android debug signer only for authorized physical tests. Keep the local debug signing home outside Git and separate from the discontinued `com.geops.mobile` app:

```powershell
New-Item -ItemType Directory -Path apps/android-app/.spec04-debug -Force | Out-Null
docker run --rm -v "${PWD}:/workspace" -v "${PWD}/apps/android-app/.spec04-debug:/root/.android" -w /workspace/apps/android-app -e GRADLE_USER_HOME=/workspace/apps/android-app/.gradle geops-android-build:local gradle assembleCorporateDebug assemblePersonalDebug --no-daemon
```

The APKs appear under `build/outputs/apk/corporate/debug/` and `build/outputs/apk/personal/debug/`. Verify each with `apksigner verify --verbose --print-certs` and `aapt dump badging` before copying to a controlled test bundle. Preserve the same debug key for updates to these test installations. Never upload a debug APK automatically to MDM or use it for production.

## Future release signing

`assembleCorporateRelease assemblePersonalRelease` produces unsigned APKs until an approved release keystore is provided through all four `GEOPS_ANDROID_RELEASE_*` variables. The existing `geops-test.jks` is excluded. Do not generate or use a release key before the separate key custody procedure is approved. Both new application IDs require new installation and enrollment; an APK for `com.geops.mobile` cannot update either flavor.
