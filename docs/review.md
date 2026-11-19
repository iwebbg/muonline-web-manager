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
session is required. `npm run test:ui` can run under Xvfb instead. On Windows,
[the source dev workflow](development-wsl.md) runs a real disposable WSL runtime
without NSIS. Installer acceptance still requires the Windows CI-built installer.

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

## EN/BG interface follow-up

English/Bulgarian catalogs, a persistent header selector, localized native menus and
validation, and bilingual NSIS pages were added after the initial handoff.
`npm test` now covers 14 Node tests and 15 Python tests. The Electron smoke test covers
all seven pages in both languages, switching with unsent form values, language after
reload, localized required-field validation and the permanent donation footer.
Screenshots use `artifacts/review/<page>-en.png` and `<page>-bg.png`. The bilingual
NSIS welcome/support macros compile in the native makensis syntax harness. Actual
Windows installer execution and native Windows dialogs still require Windows CI/VM
acceptance; this change does not claim those checks passed.

## Automatic latest-version discovery follow-up

The release settings page was removed from normal navigation. The panel now queries
the public Laravel GitHub tags API and resolves the highest stable tag to its signed
versioned CDN runtime. Installation selects the latest version afresh. The recorded
WSL version controls update availability; successful updates clear the notification.
A tagged version with missing runtime metadata is visible as pending and cannot be
applied. An older version is never silently selected.

Verification: 22 Node tests and 16 Python tests cover pagination/numeric ordering,
tag filtering, matching signatures/versions, unpublished releases, GitHub errors,
settings migration, fresh install discovery and version persistence after migrations.
The EN/BG Electron smoke covers all six remaining pages, an explicit 1.3.0→1.4.0 update
with refreshed version/notification, and a blocked pending 1.5.0. Real read-only
discovery also verified public tag v1.3.0 and its CDN manifest/signature with the pinned
key; ZIP download/application was not performed by that check. Full Windows behavior
still needs the VM checklist in [windows-vm.md](windows-vm.md).

## SQL Troubleshooting follow-up — 2026-11-17

The new seventh page supports EN/BG causes, actions, statuses, previews and reports.
It separates Windows instance/authentication/TCP/listener facts, measured WSL mode and
routes, Docker TCP/PDO, TLS, application/game/optional databases and runtime/bootstrap
permissions. System changes require a preview, explicit confirmation and Windows UAC.

Verification: 36 Node and 24 Python tests passed; all seven Electron pages passed the
EN/BG smoke test, including SQL report rendering, password clearing and confirmation.
Real isolated SQL Server 2022 + PDO/sqlsrv checks passed for successful app connection,
failed game login, bootstrap fallback, denied/missing database, certificate trust error
and no database creation. Production PowerShell functions ran with mocked OS cmdlets
and protected broad scopes, foreign PIDs and duplicate manual/manager firewall rules.
No actual Windows service, registry, UAC or firewall operation was exercised locally.
Follow [the SQL module VM checklist](sql-troubleshooting.md#windows-vm-acceptance)
before approving Windows behavior. Legacy crypto patterns were tested, not an actual
SQL 2008 R2 handshake. No adapters or sibling Laravel files were changed.

## Branding and Help & Support follow-up — 2026-11-17

The sidebar and header use MuOnline Web / Powered by InterWeb Ltd.; the native title
is MuOnline Web Manager - Powered by InterWeb Ltd. Platform labels were removed from
normal overview copy and the sidebar. The lower-left company attribution uses the
current local year and links to interweb.bg. Required setup and SQL diagnostic facts
remain available on the relevant operational screens.

The eighth page, Help & Support (EN/BG), follows the Counter-Strike project's support
layout: GitHub issue/project links for muonline-web-laravel, email contact, guidance
before reporting, SQL diagnostics navigation and three donation cards. The permanent
footer remains on every page. Only explicit clicks open the browser/email composer;
no issue is posted, no email is sent and no credentials are attached automatically.
External destinations are a fixed main-process allow-list. The smoke test covers both
languages, those links, title/attribution and sidebar overlap at minimum window size.

## Card spacing and SQL setup defaults — 2026-11-17

The first-install certificate trust option starts checked and remains user-controlled;
it does not override an existing deployment or disable encryption. Certificate-chain
verification can still be enabled by clearing it when using a valid server certificate.
The availability note now lives inside the services card, separated by a divider, and
the manager/web update cards have a 20px gap. EN/BG smoke assertions cover all three.

The new Laravel administrator list/update/delete classes were inspected as references;
at the time of this change they contained empty handlers. Their integration must use
the completed command contract rather than assuming successful listing or mutation.

## Administrator CLI integration — 2026-11-17

The web administrator page now lists administrators/Game Masters and exposes edit,
private-stdin password reset and activate/deactivate actions. Deactivation requires
confirmation; successful changes refresh the list. Safe JSON field errors, old-release
commands and non-JSON failures are handled separately. A confirmed admin:delete runtime
action is available; the UI uses Deactivate. No arbitrary SQL/tinker fallback exists.

Verification: 36 Node + 31 Python tests passed, plus all eight EN/BG UI pages and the
actual Laravel command test in its disposable network-isolated SQLite container
(19 tests, 84 assertions). A new signed web runtime with the commands/migrations is
required for installed sites. No web release was published or sibling code edited.
Windows/WSL execution against an installed release still needs the VM test. See
[administrators.md](administrators.md) for the command and release boundaries.

## Website and admin browser shortcuts — 2026-11-17

The overview now has Open Website / Open Admin Panel (EN/BG), enabled after installation
is ready and status is known. They use the saved Local/IP/Domain URL and Laravel's
actual `/admin` dashboard route, which redirects guests to admin login. Main resolves
fresh status at each click and never accepts renderer-supplied destinations. Tests
cover origin changes, unsafe URI rejection, uninstalled/incomplete states and both UI
buttons. Access changes refresh status. Browser launch uses Electron shell.openExternal;
actual Windows default-browser execution remains a VM acceptance check.

## Audit follow-up — 2026-11-17

[The audit report](audit-2026-11-17.md) records eight corrected defects, including
initial IP consent, .env/APP_KEY preservation, exact access restoration, SQL target
drift protection, renewal/recovery state, current access fields, service status refresh
and UTF-8 pipe decoding. Verification: 39 Node + 39 Python tests, eight-page EN/BG UI,
real dotenv parsing and Compose resolution, isolated release/nginx validation and Linux
packaging passed. npm audit reported zero known vulnerabilities. Windows/WSL/ACME
acceptance remains required; no production data or sibling Laravel source was changed.

## Windows NSIS warning-6030 correction — 2026-11-17

A real Windows build log exposed a fatal duplicate Bulgarian LangString definition.
The custom include could run before generated message files because electron-builder
loads them asynchronously. Moving overrides into its customHeader hook makes their
ordering deterministic after all fallbacks. Global warning-as-error behavior is kept.

The old ordering reproduced warning 6030 under the same cached NSIS 3.0.4.1 compiler.
The corrected custom pages compiled for installer/uninstaller in three include orders
(six checks with -WX), and all 78 ordinary tests passed. The new test:installer command
is in Windows CI. This fixes the reported compiler failure; the full corrected Windows
installer must still be built and executed on Windows.

## Standard Bulgarian MultiUser translations — 2026-11-17

The next Windows log reached standard MUI language expansion and exposed five missing
Bulgarian MultiUser translations in the pinned NSIS 3.0.4.1 language file. The original
custom-page harness did not enable this standard page's language flag. It now enables
that flag and uses the builder's actual addLangs macro, reproducing the reported failure
before correction. installer-languages.nsh supplies all five missing messages before
Bulgarian fallback expansion. All six -WX compiler contracts pass with the correction.
No global warning suppression or NSIS cache patch is used. The final Windows build/run
still requires the operator's Windows environment.

## Support-page MUI dependency order — 2026-11-17

A subsequent full Windows installer build exposed MUI_HEADER_TEXT being referenced
while the custom include was loaded before MUI2. The earlier harness incorrectly
preloaded MUI2 and missed the error. The revised include-order test reproduced the
exact failure. Callback definitions now live inside customPageAfterChangeDir and
are emitted only when the support page is inserted after MUI2 initialization.

Verification now includes six page/language ordering contracts plus both complete
electron-builder NSIS templates, using the real generated header, stdin mode and
template working directory with -WX. All eight compile checks and 78 ordinary tests
passed. Complete-template tests embed disposable fixture payloads and never execute
their outputs; they are not distributable installers or a Windows runtime test.

## Windows Python CI portability — 2026-11-17

The Windows runner exposed two platform-specific failures. Text-mode atomic writes
expanded existing CRLF into CR-CR-LF when preserving an environment file. Atomic writes
now encode strings explicitly as UTF-8 and write bytes without newline translation.
ZIP fixtures previously passed names to ZipInfo's constructor, which normalizes
backslashes on Windows. Fixtures now preserve raw archive metadata; extraction checks
orig_filename and rejects normalization/truncation, backslashes and control characters
before any extraction. No security assertion or Windows test was skipped to fix these.

Regression checks reproduce Windows newline translation and ZipInfo normalization on
Linux, including malformed raw NUL names. All 39 Node and 41 Python tests passed locally.
The actual Windows CI rerun remains required to confirm the runner result.


## SQL cleanup before runtime removal — 2026-11-17

The manager now uses the Laravel `app:database:uninstall` contract documented in the
sibling installation guide. The panel displays the saved SQL endpoint/web database/login,
requires separate SQL confirmation plus temporary sysadmin credentials, and offers the
backup page before irreversible removal. EN/BG errors report separate database/login
progress. Passwords and SQL confirmation are cleared after both success and refusal.

The worker checks target drift, checkpoints uninstall-sql-pending, stops website
services and invokes a one-shot application container with the PHP entrypoint, argument
arrays and private JSON stdin. Exit status and bounded JSON resource states must both
prove complete success before uninstall-sql-complete and Windows task/WSL removal.
Partial SQL deletion cannot be rolled back; runtime/configuration remain for retry.
No game cleanup or credential persistence was added. An older release without the
command fails closed and requires a web release containing it.

Verification: 58 Node and 64 Python tests pass, plus the Electron EN/BG smoke test
covering refused SQL cleanup, retry, confirmation and password erasure. The actual
Laravel command was also invoked from current read-only application source with
image-provided vendor in a disposable network-disabled PHP container: missing-force
and malformed-input refusals returned the expected JSON and exit 1. No SQL was touched.
Actual SQL DROP/login removal and the complete Windows/WSL sequence still require
acceptance testing on a disposable installation. The sibling Laravel files were not
modified by this manager integration.


## Visible operation progress — 2026-11-18

Explicit longer panel actions now show an EN/BG modal overlay with an animated
activity indicator, operation title and elapsed time. Setup journal polling supplies
actual stage changes during installation/resume. No percentage or unmeasured SQL
substage is invented. The overlay stays until follow-up status/feed refreshes finish;
quiet background polling does not open one. Fast actions avoid flashing through a
short delay. The permanent donation footer remains visible below the modal.

Escape cannot dismiss progress and imply cancellation of the ongoing runtime action.
The dialog handles keyboard focus and reduced-motion preferences disable animation.
Errors dismiss the overlay, mark the operation console and scroll/focus its output.
Backend execution, permissions and credential handling are unchanged.

Electron smoke coverage delays Start/Stop/Restart and setup requests, checks elapsed
time, real journal stage transitions in both languages, Escape handling, footer
visibility, final status refresh and error cleanup/focus/scroll. Review screenshots
are generated at artifacts/review/progress-en.png and progress-bg.png. Native Windows
rendering and the actual installation timing still require Windows acceptance tests.


## WSL resource/load acceptance tooling — 2026-11-18

Source-only `resources:wsl` previews global 2 GB RAM / 2 CPU / 1 GB disk swap limits.
Applying requires --apply --confirm-global, retains unrelated INI values/comments
and UTF-8/UTF-16LE encoding, backs up exact prior bytes and never shuts down WSL.
It is not an automatic manager install step and does not claim per-distro isolation.

The dependency-free external Node load generator supplies paused visitors, a single
burst and sustained concurrent GET modes, bounded to 200 clients. It keeps independent
in-memory cookie jars, does not submit accounts/game actions, follow redirects or
weaken TLS checks, and records per-route timings, failures and request rates without
response bodies or cookies. Public forms are not authenticated business transactions.

All 64 Node and 64 Python tests pass. Local HTTP fixtures verify a 200-request burst,
429 accounting, separate visitor sessions, no redirect following, timeout and interruption
handling; temporary file fixtures verify INI preservation and exact backup/stale-preview
behavior. No installed website, Windows WSL configuration or remote SQL was touched.
The actual Windows limit activation and application capacity remain VM acceptance work;
see performance.md for remote SQL observation and comparable 2 GB/4 GB runs.


## Clean Windows WSL reboot boundary — 2026-11-18

A real clean Windows VM log showed WSL feature installation returning exit 0 while
printing that a reboot was required. The manager trusted the exit code, then failed
on empty distro inventory instead of presenting the reboot checkpoint.

Machine preparation now uses a packaged elevated PowerShell script that reads actual
Windows optional-feature states, enables missing features with NoRestart, and returns
3010 for newly enabled/pending features independently of WSL's success code. The
original user's non-elevated session still owns distro installation. After successful
machine preparation, an empty inventory is not queried again: it proceeds directly
to installing the fixed Ubuntu distro. No automatic Windows/WSL restart was added.

129 tests pass on Linux, including the empty-inventory/resume regression. Five added
PowerShell contracts run only on Windows CI, mock all feature/WSL commands and never
change Windows features. They have not run locally. Actual UAC, feature activation,
reboot and resume still require the user's clean Windows VM check with a new build.


## Legacy Windows 10 inbox WSL — 2026-11-19

The Windows 10 VM returned wsl.exe usage text after the feature reboot. A subsequent
manual --version returned "Invalid command line option" and advertised legacy
--update/--web-download without --no-distribution or --no-launch, confirming inbox WSL. The old setup assumed enabling Windows features also made
all modern WSL installation flags available.

Setup now probes --version even with successful distro inventory. The elevated helper
checks advertised --version/--install/--no-distribution/--no-launch flags, uses --update
only if advertised (with --web-download when supported), and rechecks afterward. A successful legacy kernel-only update does
not qualify as modern WSL readiness. A bounded EN/BG message requests Windows/current
Store WSL updates when necessary, retaining installed distros and preventing unsupported
install commands. New Windows CI contracts cover legacy updater outcomes and null-bearing
help output; these PowerShell contracts do not run on this Linux workstation.

Verification: 131 tests passed locally; 10 PowerShell contracts are Windows-only and
remain unexecuted on this Linux workstation. Actual inbox upgrade/UAC and resumed
installation still need the Windows VM test. No distributions or SQL data were removed.


## Automatic signed WSL MSI fallback — 2026-11-19

The normal Install/Resume flow now includes full WSL runtime installation when the
legacy updater fails or only updates the kernel. The user does not need PowerShell
commands or a separate manual MSI step. The existing elevated Windows preparation
helper obtains only stable x64 assets from microsoft/WSL, verifies canonical source,
HTTPS asset host, bounded size, SHA256 and independent valid Microsoft Authenticode
signature, and invokes msiexec /qn /norestart. A read lock spans verification/install;
temporary downloads are cleaned in finally. Existing application manifest trust and
SQL/runtime credentials are unchanged. The loader's EN/BG Windows stage now describes
preparation and component updating rather than feature activation only.

Unit/UI verification covers bounded failure messages, no distro install after failed
runtime setup, loader copy and normal recovery. Windows-only PowerShell contracts mock
network, signatures and msiexec: they test matching hashes with invalid signatures,
wrong publishers, untrusted source URLs, MSI failures and required restarts. They do not
perform downloads or OS changes. Actual signed MSI execution and Win10/Win11/UAC remain
unverified on this Linux workstation and require the clean Windows VM acceptance run.

Final verification for this change: 132 local Node/Python tests passed and the
Electron EN/BG smoke test passed. The 19 PowerShell contracts are Windows-only and
were skipped on Linux; their pass status is not inferred from the other tests.

## SQL bootstrap endpoint recovery — 2026-11-19

`npm test` passed: 70 Node tests and 72 Python tests; 19 Windows-only tests skipped
on Linux. New checks cover measured local SQL suggestions, original bootstrap error
preservation, current-attempt temporary admin credentials, exact configuration backup
and restore, stale confirmation refusal and stable runtime passwords/APP_KEY.

`npm run test:ui` passed on Linux with isolated IPC: a saved loopback failure shows
the measured alternative, selecting it requires same-instance confirmation, Resume
receives corrected temporary SQL username/password, and password fields clear after
the attempt. All eight pages remain translated in EN/BG with the donate footer.
These checks do not verify Windows networking, live SQL provisioning or the NSIS
build. Retest the new Windows build against the VM's actual WSL gateway and SQL
instance; no migration/provisioning rollback is promised.

## Windows WSL elevation length — 2026-11-19

Replaced nested encoded installer source with a fixed, short wrapper and the packaged
PS1 file path via UTF-8 JSON stdin. The regression test bounds argv below 8192
characters, checks quoted `-File`/UAC invocation, exercises spaces/Cyrillic paths and
retains reboot journaling. `npm test`: 71 Node and 72 Python tests passed; 19 native
Windows tests skipped on Linux. Real Windows UAC execution still needs the new build.
