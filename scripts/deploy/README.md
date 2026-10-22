# GEOPS Deploy P0 on the 21-migration code line

This directory contains a manual, digest-pinned release path. No workflow or script deploys automatically. The GitHub workflow runs only through workflow_dispatch; publishing defaults to false and requires the full approved SHA of main, successful SPEC-02 CI for that exact SHA, and a separate publication decision. API builds once; both Web variants build on independent runners. The manifest records the API digest, two distinct Web digests, source CI run, publication run, SQL checksums, and both Web build variants.

## Web artifact variant

The `gps-base` Web digest is built with MDM_ENABLED=false; `mdm-qa` uses MDM_ENABLED=true and the opt-in Compose MDM overlay. Both use GEOPS_WEB_BASE=/, VITE_GPS_TIME_ZONE=America/Costa_Rica, and no custom VITE_GPS_TILE_URL. These are build inputs, and each digest carries a variant label. `create-plan.mjs` requires an explicit `gps-base` or `mdm-qa` selection; preflight checks Compose against that selection, and release verifies the downloaded Web image label. A different setting requires another identified digest. Never place secrets in Web configuration.

## SQL and deployment boundary

create-manifest.mjs inventories all 21 SQL files and SHA-256 checksums. create-plan.mjs accepts identical SQL for automatic image switching. It also recognizes additive SQL prefixes, but crossing 0019_mdm_security.sql or 0021_gps_offline_policy_contract.sql is blocked for the generic expand migrator: those migrations change constraints and require a supervised compatibility and recovery procedure. The normal release.mjs path accepts only identical candidate/previous SQL. Image rollback does not reverse the database.

A Staging host must first be inspected read-only. Do not infer deployed code from its checkout, a mutable tag, or a branch pointer. For an approved release, preserve private manifests for both stable and candidate versions, exact digests, backup/restore evidence, gate and epoch evidence, and a maintenance decision. Never remove stable images before the rollback window closes.

## First 18-to-21 Staging upgrade

This is a supervised schema transition, not a normal digest switch. Confirm the live SQL version and running image digests on the host before using this sequence; a checkout SHA alone is insufficient. Migration 0019 changes the MDM outcome constraint, 0020 adds mixed GPS batch receipts, and 0021 adds offline-policy constraints, indexes and time-evidence fields. The generic plan and release scripts deliberately reject an 18-to-21 automatic rollout.

1. Record the active digests, SQL versions, gate state and epoch, container health, GPS position and receipt counts, and current backup inventory. Keep the existing volumes and images.
2. Create a new PostgreSQL custom-format backup with a SHA-256 checksum. Restore it to an isolated database and verify the checksum, migration history, GPS counts and gate recovery procedure before scheduling a maintenance window.
3. Pull and verify the 21-SQL API/Web digests and compare the SQL checksums embedded in the API image with its release manifest. Rehearse 0019–0021 and GPS retry/idempotency checks against the isolated restore. Record each duration.
4. Only with separate Staging deployment authorization, close the gate and drain API/Web through the approved maintenance procedure. Keep PostgreSQL running. Apply 0019–0021 under explicit epoch and target confirmation, then verify schema, data counts, readiness and smoke tests before reopening the gate.
5. If migration or validation fails, keep the gate closed. Recover forward or restore the verified database backup under the security-epoch recovery procedure. Switching containers back to an 18-SQL image is not a database rollback and is not an automatic recovery path.

After a healthy 21-SQL baseline exists, retain its digest as the stable version. Normal `release.mjs` deploy/rollback requires both manifests to contain identical 21 SQL checksums; only then can a later candidate use image-only rollback. Measure this bootstrap separately from the normal deployment and rollback targets.

## Command sequence after separate approvals

All commands run from a clean checkout of the candidate SHA, with private files outside Git:

1. node scripts/deploy/create-plan.mjs CANDIDATE_MANIFEST PREVIOUS_MANIFEST PRIVATE_PLAN gps-base|mdm-qa
2. node scripts/deploy/preflight.mjs --plan PRIVATE_PLAN --plan-only
3. node scripts/deploy/preflight.mjs --plan PRIVATE_PLAN --env-file PRIVATE_ENV --target candidate
4. node scripts/deploy/preflight.mjs --plan PRIVATE_PLAN --env-file PRIVATE_ENV --target previous
5. With pull authorization: node scripts/deploy/release.mjs prepare --plan PRIVATE_PLAN --env-file PRIVATE_ENV --log PRIVATE_TIMINGS --state PRIVATE_STATE --execute
6. Recheck both digests locally with preflight.mjs --verify-local-images, inspect database/gate/backup, then seek deployment authorization.
7. With deployment authorization and identical SQL: node scripts/deploy/release.mjs deploy --plan PRIVATE_PLAN --env-file PRIVATE_ENV --log PRIVATE_TIMINGS --state PRIVATE_STATE --execute
8. If readiness or smoke fails, the release script attempts the already downloaded previous digests. A separately authorized manual rollback uses the same command with rollback.

The scripts record UTC timestamps and durations, require local Docker context, verify image digests, OCI revision and Web variant labels, compare embedded API SQL to both manifests, and compare the live PostgreSQL migration ledger with all approved checksums before switching. They change only API/Web through the Compose digest overlay and retain the database container. Do not run down, prune, migration, or gate commands as part of image rollback. A failure after a schema change needs forward recovery under the supervised Staging procedure.

The historic 15-migration A/B rehearsal in codex/deploy-p0 proved local mechanics only. A 21-migration, authenticated GHCR and Staging rehearsal is still required; existing synthetic measurements are not operational acceptance.
