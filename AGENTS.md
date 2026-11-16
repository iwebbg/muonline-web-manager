# MuOnline Web Manager

This repository owns the Windows Electron/NSIS manager and WSL runtime. The sibling
`../muonline-web-laravel` repository is a read-only integration reference unless the
user explicitly requests a change there. Do not stage its uncommitted changes.

Read [the manager skill](skills/muonline-manager/SKILL.md) when changing deployment,
release packaging, IPC, bootstrap, access modes or recovery. Read the relevant
architecture/release/recovery document linked from the skill before changing that
contract. No delegation is required by this repository.

Use Node 24+, Electron ES modules, a sandboxed renderer and narrow preload methods.
Runtime operations belong in `runtime/worker.py`; subprocesses receive argv arrays.
User data and secrets never become shell source or process arguments. Keep bootstrap
credentials out of persisted deployment state, output and release artifacts.

Use descriptive names, document operation boundaries and recovery assumptions, and
keep changes independently reviewable. Run `npm test` for backend/release changes;
run `npm run test:ui` with a display/Xvfb for panel/preload changes. Windows CI owns
the NSIS build. Tests must not connect to production SQL or mutate the sibling repo.
Do not claim Windows/SSL/SQL integration passed based on mocked tests.

The three donation links stay visible on every panel page and in NSIS. No automatic
update application, CDN upload, push or database migration rollback. A user-requested
release may be prepared and signed with an authorized key, but publishing needs an
explicit instruction. Never commit private keys, vendor, node_modules or artifacts.
