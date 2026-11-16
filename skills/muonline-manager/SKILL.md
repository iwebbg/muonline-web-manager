---
name: muonline-manager
description: Implement and verify this repository's Electron Windows manager, WSL Docker lifecycle, Laravel bootstrap integration and signed release tooling. Use for deployment or recovery changes in MuOnline Web Manager.
---

Read the appropriate repository document before changing a contract:

- [Architecture](../../docs/architecture.md): IPC, WSL identity, Compose and access modes.
- [Releases](../../docs/releases.md): production exports, signing, R2 paths, manager updates.
- [Recovery](../../docs/recovery.md): partial bootstrap, config restore and migration failure.
- [Review](../../docs/review.md): evidence and outstanding Windows acceptance checks.

Discover commands and profile keys from the actual sibling Laravel source or the
verified release, rather than copying an adapter list. `admin:create` currently uses
interactive stdin. `app:backup` supports SQLite only; SQL deployments use native SQL
backups with temporary authorization. Game bootstrap provisions access to an existing
game database; it does not create a game server schema from nothing.

Keep the signature-before-parse/download boundary in `src/main/releases.js` and the
fixed action boundary in `src/main/backend.js`. Renderer-supplied input must never
override an authenticated manifest, local archive paths, or a selected runtime action.
Only build-pinned public Ed25519 keys are trusted; an empty trust store must fail closed.

Maintain the runtime phases and explicit recovery semantics. Configuration restoration
can be automatic; SQL migrations cannot be presumed reversible. Preserve APP_KEY,
.env, uploaded data and modified/custom themes. Do not overwrite stock theme fixes
with unchanged old templates during updates.

For checks, use `npm test`; the Electron smoke test also captures all seven pages.
Use `scripts/test-laravel-contract.py` only with a disposable network-isolated test
image. Production runtime packaging uses a clean Git snapshot by default and leaves
local Laravel edits untouched. Never infer a successful upload from local artifacts.
