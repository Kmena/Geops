# GEOPS Deploy P0 on the 21-migration code line

This directory contains a manual, digest-pinned release path. No workflow or script deploys automatically. The GitHub workflow runs only through workflow_dispatch; publishing defaults to false and requires the full approved SHA of main, successful SPEC-02 CI for that exact SHA, and a separate publication decision. API and Web build once on independent runners. The manifest records both GHCR digests, source CI run, publication run, SQL checksums, and the fixed Web build variant.

## Web artifact variant

The current Web bundle is built with GEOPS_WEB_BASE=/, MDM_ENABLED=false, VITE_GPS_TIME_ZONE=America/Costa_Rica, and no custom VITE_GPS_TILE_URL. These are build inputs. A different environment setting requires a separately identified Web digest until public runtime configuration is implemented and tested. Never place secrets in Web configuration.

## SQL and deployment boundary

create-manifest.mjs inventories all 21 SQL files and SHA-256 checksums. create-plan.mjs accepts identical SQL for automatic image switching. It also recognizes additive SQL prefixes, but crossing 0019_mdm_security.sql or 0021_gps_offline_policy_contract.sql is blocked for the generic expand migrator: those migrations change constraints and require a supervised compatibility and recovery procedure. The normal release.mjs path accepts only identical candidate/previous SQL. Image rollback does not reverse the database.

A Staging host must first be inspected read-only. Do not infer deployed code from its checkout, a mutable tag, or a branch pointer. For an approved release, preserve private manifests for both stable and candidate versions, exact digests, backup/restore evidence, gate and epoch evidence, and a maintenance decision. Never remove stable images before the rollback window closes.

## Command sequence after separate approvals

All commands run from a clean checkout of the candidate SHA, with private files outside Git:

1. node scripts/deploy/create-plan.mjs CANDIDATE_MANIFEST PREVIOUS_MANIFEST PRIVATE_PLAN
2. node scripts/deploy/preflight.mjs --plan PRIVATE_PLAN --plan-only
3. node scripts/deploy/preflight.mjs --plan PRIVATE_PLAN --env-file PRIVATE_ENV --target candidate
4. node scripts/deploy/preflight.mjs --plan PRIVATE_PLAN --env-file PRIVATE_ENV --target previous
5. With pull authorization: node scripts/deploy/release.mjs prepare --plan PRIVATE_PLAN --env-file PRIVATE_ENV --log PRIVATE_TIMINGS --state PRIVATE_STATE --execute
6. Recheck both digests locally with preflight.mjs --verify-local-images, inspect database/gate/backup, then seek deployment authorization.
7. With deployment authorization and identical SQL: node scripts/deploy/release.mjs deploy --plan PRIVATE_PLAN --env-file PRIVATE_ENV --log PRIVATE_TIMINGS --state PRIVATE_STATE --execute
8. If readiness or smoke fails, the release script attempts the already downloaded previous digests. A separately authorized manual rollback uses the same command with rollback.

The scripts record UTC timestamps and durations, require local Docker context, verify image digests and OCI revision labels, compare embedded API SQL to both manifests, change only API/Web through the Compose digest overlay, and retain the database container. Do not run down, prune, migration, or gate commands as part of image rollback. A failure after a schema change needs forward recovery under the supervised Staging procedure.

The historic 15-migration A/B rehearsal in codex/deploy-p0 proved local mechanics only. A 21-migration, authenticated GHCR and Staging rehearsal is still required; existing synthetic measurements are not operational acceptance.
