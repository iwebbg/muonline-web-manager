# Review handoff — 2026-11-16

This is an implemented code/UI review candidate. It is **not** a verified production
Windows installer. No commit was pushed and no CDN object was uploaded.

## What can be reviewed now

The seven-page Electron panel has first-install/WSL/Docker setup, runtime controls,
status/logs, SQL diagnostics, administrator creation, access/SSL configuration,
backups, separate web/manager updates and configurable feeds. All panel pages have
the persistent three-link donate footer. NSIS includes visible URLs and a separate
optional support page with clickable links.

Backend operations are implemented in the WSL worker, rather than UI placeholders.
They are intentionally inaccessible on a Linux development desktop. The UI smoke test
uses an explicit test harness with stubbed IPC, not a claim of a live installed site.

Start a local preview with Node 24+:

```sh
npm ci
node node_modules/electron/install.js  # only needed if npm withheld dependency install scripts
npm start
```

On Linux, unset ELECTRON_RUN_AS_NODE if inherited from the terminal. A graphical
session is required. `npm run test:ui` can run under Xvfb instead. On Windows use the
CI-built installer once the branch is pushed/reviewed by an operator.

## Verified locally

| Check | Result / scope |
| --- | --- |
| `npm test` | 11 Node tests and 15 Python tests passed; signature tampering, invalid trust, feed paths, hash/size staging, ZIP traversal/links, permissions, backup secret transport, access restore, bootstrap cleanup/resume, theme preservation, and no SQL rollback after migration failure |
| `npm run test:ui` | Passed using Electron 45.3.3 on an isolated Linux Xvfb display; navigated all seven pages, captured full-size screenshots, checked donate footer, bridge restriction, admin submission/password clearing and absence of automatic apply |
| `npm audit` | 0 known vulnerabilities at the time of review; patched minimatch override locked to 11.0.1 |
| Existing Laravel admin tests | Disposable network-isolated PHP 8.5 test image: 4 tests, 30 assertions passed |
| `scripts/test-laravel-contract.py` | Real admin:create accepted a Cyrillic name and private stdin, created an administrator, and did not echo the generated password; disposable SQLite only |
| `scripts/test-sql-backup.py` | Real SQL Server 2022 + PDO/sqlsrv on an internal disposable Docker network: native backup and VERIFYONLY passed for both databases; no host port or production connection |
| `scripts/package-release.py` | Real source production Docker build, production vendor and compiled Vite assets exported; local ZIPs/manifest generated |
| `scripts/test-runtime-release.py` | Real ZIP hashes/registry/staging, www-data read access, Compose validation and nginx -t for Local/IP/ACME-bootstrap configs passed in disposable containers |
| electron-builder Linux directory build | Passed; app.asar and runtime/trust resources packaged |
| NSIS custom pages | Compiled the welcome/support page macros with native makensis in an isolated syntax harness; not an end-to-end installer |
| Project skill | `quick_validate.py skills/muonline-manager` passed |

The runtime ZIP build used Laravel commit
`2054b7ce7b8ba7ebaa92022039d7e39818444a84`, a clean Git HEAD snapshot. It deliberately
did not include or edit the user's uncommitted Laravel work. The game adapters were
not changed. Docker tests used new disposable containers; the long-running site was
not restarted or reconfigured.

Local ignored artifacts:

- `artifacts/review/{overview,install,access,admins,backup,updates,settings}.png`
- `artifacts/web/application.zip` — 88,658,867 bytes
- `artifacts/web/vendor.zip` — 8,214,027 bytes
- `artifacts/web/manifest.json` — unsigned preparation manifest
- `dist/linux-unpacked/` — packaging check output

The Windows unpacked directory from an additional Linux cross-build is **not** a
finished installer. That attempt reached NSIS but failed because Wine was absent.
Its partial installer executable was removed to prevent accidental distribution.
Windows CI is configured but has not run from this local, unpushed branch.

## Required Windows acceptance checks

Run these on a disposable Windows 11 x64 VM and a separate test SQL Server/game fixture.

1. Build with the Windows workflow; install/uninstall the assisted NSIS package.
   Check both donate pages/links, app paths with spaces/Cyrillic usernames and UAC.
2. Test WSL missing, reboot-required and already-installed states. Verify Ubuntu
   belongs to the intended Windows user, uses WSL2, and has systemd/Python available.
3. Install Docker, verify the root-only socket and Compose support, and inspect the
   current user's MuOnline-Web-WSL scheduled task. Close the panel and confirm HTTP
   and background services continue. Test logoff/logon, reboot, battery and sleep.
4. Pin the operator's real public trust key, sign/publish a test release at an
   explicitly authorized endpoint, and test successful and corrupted downloads.
   The empty trust store in this repository deliberately prevents installation.
5. Run complete SQL bootstrap against restored disposable schemas, for each supported
   profile. Check restricted runtime permissions, migrations, APP_KEY, seeding, admin
   login and removal of bootstrap credentials/container. Interrupt/resume each phase.
6. Test localhost on Windows; IP HTTP in local and production APP_ENV; LAN/public
   access with the intended WSL networking mode, firewall and NAT. The panel does not
   configure portproxy, firewall or router rules automatically.
7. Use real DNS and ACME staging/production policy appropriate to your test environment
   to verify Domain + SSL, domain changes, cookies, renewal and rollback after failed
   issuance. Current code uses Certbot's default production ACME endpoint; avoid rate
   limits and use a dedicated domain/controlled test configuration for this check.
8. Apply a real signed web upgrade, verify preserved data/custom themes and stock theme
   fixes, then inject migration failure and perform manual database recovery. Native
   SQL backup has been checked locally; the whole WSL update workflow has not.
9. Verify the separate manager Update handoff closes the panel and launches NSIS while
   WSL services remain available. Configure/test Authenticode before public release.

Public hosting on WSL still depends on Windows uptime, networking and the logged-in
user's scheduled task. This implementation does not promise pre-login server hosting,
automatic firewall/NAT changes or automatic database migration rollback.

## Sources checked for implementation choices

- [Electron stable releases](https://releases.electronjs.org/release?channel=stable)
  and npm registry: Electron 45.3.3.
- [electron-builder releases](https://github.com/electron-userland/electron-builder/releases)
  and npm registry: electron-builder 26.18.0.
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
  for sandboxing, context isolation and IPC sender validation.
- [Microsoft WSL commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)
  and [systemd guidance](https://learn.microsoft.com/en-us/windows/wsl/systemd).
- The actual Laravel Docker files, docker/install.sh, entrypoint, registry and command
  implementations; notably the interactive admin:create and SQLite-only app:backup.
