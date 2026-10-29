# B32 staging promotion

This package promotes the pinned B31 staging installation (31 migrations) to the
integrated Android v9 / B32 application commit, with 33 migrations. The ordinary
API image keeps its recovery ceiling at schema 31. A separate recovery image is
restricted to supervised schema 33 recovery.

`candidate.py verify` checks the committed application inventory. `package.py`
builds a deterministic policy bundle from the three immutable registry digests,
the approved public key, and the promotion commit. `install.py` requires a valid
Ed25519 signature, verifies the complete bundle and the healthy B31 source, and
installs the root protected B32 wrapper. Installation does not start maintenance.

The controller requires a signed release, an isolated B31 backup restore proof,
and a signed one time approval before it can close the gate. Migrations run only
after maintenance starts. The controller cannot reopen the gate itself: a signed
supervised recovery proof must attest to either exact schema 31 rollback or exact
schema 33 promotion. Schema downgrade is forbidden.

Only an administrator with existing root authorization can install the signed
bundle and create the protected recovery evidence. The SSH operator's current
passwordless sudo grant covers B31 only. Until installation and all proofs are
completed, staging remains B31.
