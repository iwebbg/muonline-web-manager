# Operations and recovery

The runtime data directory is private and contains credentials. Backups are private
as well. Use WSL root to inspect it; do not paste .env/state.json into issue reports.
Never use `docker compose config` output in public logs: it can contain resolved secrets.
Docker failures report the fixed operation (build/start/bootstrap/etc.), a classified
reason and, when available, a Dockerfile line number. Raw stdout/stderr, arguments,
temporary bootstrap paths and SQL identities remain withheld. These categories are
diagnostic hints, not proof of the underlying cause. Retry Resume after correcting
the reported cause; do not reset WSL or drop databases to investigate a build error.

The fixed project command inside Ubuntu-24.04 is:

```sh
docker compose -p muonline-manager -f /opt/muonline-web/compose.json ps
```

Start/Stop/Restart in the panel operate on this project. Stop keeps containers, volumes,
site data and SQL databases. Closing the panel does not stop Docker. The user logon
keepalive task does not make Windows an always-on server before login or during sleep.

## Interrupted initial installation

The desktop `installation.json` in Electron userData records environment/application
setup progress independently of private WSL state.json. Click Install or Resume to
re-measure completed environment steps, retry the failed step and then resume any
bootstrap-pending/runtime-bootstrapped/administrator-created application phase.
Ready installations are not installed again. Recovery-required migration/access
phases are never bypassed. Public form fields and the Linux username survive panel
restart; temporary SQL/bootstrap administrator passwords do not and must be re-entered.
There is no automatic resume on application startup or automatic reboot.
Machine feature setup checks actual Windows optional-feature state: newly enabled or
pending features save a restartRequired checkpoint even if wsl.exe reports exit 0.
Restart Windows, then click Install/Resume. An empty distro inventory after machine
preparation proceeds to Ubuntu installation; it does not require manual distro setup.
Older Windows 10 inbox WSL may still enumerate distros while rejecting --version or
modern install flags. Setup probes this case and the elevated helper reads advertised
flags before invoking them. It tries --update only when advertised, adding
--web-download only when supported to avoid requiring Store access, then rechecks.
A kernel-only update is insufficient. If modern flags remain absent, setup automatically
retrieves the stable x64 MSI from the fixed microsoft/WSL GitHub repository. Windows
builds below 19044 stop with a Windows-update instruction. Metadata must name one bounded
x64 MSI with the canonical Microsoft repository URL and a SHA256 digest. The download
must finish on an allowed HTTPS GitHub asset host; size and digest must match. Windows
must independently report a valid Authenticode signature whose publisher organization
is Microsoft Corporation. The checksum is not a signature and never replaces that check.
The package stays read-locked during verification and installation, then temporary
files are removed. No renderer-supplied URL or command is used.

The already elevated helper invokes Windows Installer with /qn /norestart. Successful
full-runtime installation (including exit 0), or an update that first enables the
modern CLI flags, ends at a restartRequired checkpoint before distro work. Existing
modern runtimes do not receive this extra upgrade restart. Native reboot codes also
become a restartRequired checkpoint; no automatic reboot or global WSL shutdown runs. Download, verification,
installer and activation failures have bounded EN/BG recovery messages and retain the
distros. It never falls back to WSL1 or an interactive distro installer. The ordinary
user needs only Install/Resume and the requested Windows UAC/reboot actions.
Resume repairs ownership of the manager-created Laravel storage directories before
starting the non-root bootstrap container. Earlier installs left storage parent
directories root-owned, causing the entrypoint's chmod to fail before any SQL work.
The mutable storage tree belongs to uid/gid 33; application code and bootstrap's
parent directory do not become writable by the runtime. Existing uploads are kept.

The manager-created muonline Linux account has a locked password, with Windows WSL
identity providing access. Use `wsl -d <distribution> -u muonline --exec /bin/bash`
for a normal shell, or explicit `-u root --exec /bin/bash` for recovery. Existing Linux
passwords are not reset. If systemd preparation changed wsl.conf, the original is at
`/opt/muonline-web/wsl.conf.before-manager`; custom options are retained in the active
file. The manager may terminate only its selected distro to activate systemd.

Status reports `bootstrap-pending`, `runtime-bootstrapped` or `administrator-created`
until installation succeeds. The first-install form's **Продължи прекъсната инсталация**
button resumes from this phase. Re-enter temporary SQL authorization when bootstrap
is still pending. Each attempt uses the currently entered temporary SQL username and
password; neither is restored from a previous attempt. The password field is cleared
after the operation. Other SQL settings and generated runtime passwords come from
the saved private state. Re-enter administrator details only if the phase has not passed
that step. Resume does not rotate APP_KEY or regenerate runtime SQL passwords.

While `bootstrap-pending`, the form displays the saved SQL endpoint. Correcting a
host/port requires explicit confirmation that the new address reaches the **same
SQL Server instance**. A Docker TCP probe must succeed before saving. The worker
backs up state, Compose, `.env` and nginx configuration privately, then updates both
state and `.env`. Database names, restricted logins, profile, generated passwords
and APP_KEY remain unchanged. This is endpoint repair, not a database/server move;
SQL effects from a previous partial attempt may already exist.

Ordinary configuration failures restore the exact backup. An interruption during
`bootstrap-endpoint-changing`, or `bootstrap-endpoint-recovery-required` after failed
restoration, blocks normal Start/Resume: inspect and restore the private backup
before proceeding. There is no automatic rollback of SQL provisioning or migrations.

If ACME fails after administrator creation, fix DNS/firewall/port reachability and
resume. The phase prevents creating the same administrator a second time. A forced
process kill in the tiny interval between successful admin creation and phase save
can require choosing a different admin email or inspecting the administrators table
manually. There is no SQL credential recovery bypass or automatic DB deletion.

Bootstrap credentials are removed after the one-shot bootstrap finishes (also on
ordinary command errors). If an OS/process kill interrupts cleanup, inspect/remove
stale `/dev/shm/muonline-bootstrap-*` files after confirming no worker/bootstrap is
running; /dev/shm is cleared by Linux restart. Do not leave interrupted bootstrap
containers running with administrator credentials.

If application/ exists but state.json does not (e.g. interruption before first state
write), inspect and recover the staged runtime manually rather than deleting/replacing
it through another first install. Do not repeat provisioning against unrelated databases.

## Game write setting changes

The overview's Apply and restart action saves .env/state.json under a private
`backups/game-writes-*` directory before changing the two write flags. It recreates
the project and waits for health; existing uploads, APP_KEY and unrelated dotenv
settings are preserved. Ordinary failures restore exact previous files and restart
the previous configuration. Failure of that restart records
`game-writes-recovery-required` with the backup path; automatic Start/update/write
changes are blocked until manual configuration recovery. A hard interruption during
`game-writes-changing` also requires inspection. Restore matching .env/state files,
clear Laravel config and recreate the project only after checking that backup.

Configuration restoration does not undo game database writes that may have occurred
while the enabled application was running. There is no automatic SQL rollback.

## Failed access changes

Each change saves state.json, compose.json, .env and nginx.conf under
`backups/access-<timestamp>-<nonce>/`. Ordinary validation failures change nothing.
Runtime/ACME/health failures restore the exact backed-up configuration files and recreate
the services. An explicit error identifies when recovery also failed. Inspect the
private backup and DNS/ports, then restore matching state/.env/Compose/nginx files
and restart the project. Preserve certificate directories; they are domain-specific.
APP_ENV and APP_KEY are never changed by an access switch. Existing unrelated `.env`
values and comments are retained; only URL/cookie keys belong to access changes.
If restoration or service recovery fails, state is marked `access-recovery-required`
when it can be written, with a private backup path. Start and web updates remain
blocked until the matching files/services have been recovered manually.

Initial SSL setup has no prior working SSL configuration; it keeps the incomplete
installation state and offers resume instead of claiming a successful rollback.

## Backups

Before backup/update, resolved SQL targets and game profile must match the saved
installation. A drift or DB_URL override stops update before maintenance or staging;
reconcile the intended database configuration instead of dismissing the check.

The panel requests temporary SQL authorization for every backup/update. Native
COPY_ONLY/CHECKSUM backups are created for both application and game databases and
checked with RESTORE VERIFYONLY. The directory is on the SQL Server host, not the
Windows panel or WSL filesystem. It must already exist and be writable by the SQL
Server service account. The supplied SQL login needs BACKUP DATABASE and permissions
required by RESTORE VERIFYONLY. Runtime restricted SQL identities are not elevated.

A WSL file backup contains the application, runtime vendor/build, .env/APP_KEY,
storage, themes, state, nginx/Compose configuration and certificates. backup.json
records version and SQL .bak locations, not temporary authorization. Copy the WSL
archive and both SQL backups to protected off-machine storage; a local backup is not
disaster recovery. SQL native backups are consistent individually; this is not an
atomic snapshot spanning both databases or the separately running game server.

A standalone file backup is best-effort for files while the site is live. Web updates
enter maintenance and stop queue/scheduler before backup. Coordinate with the game
server operator for a cross-application maintenance window if that consistency is
needed. Redis sessions/cache are not included in the file archive. Restore access to
APP_KEY and encrypted data before bringing traffic back.

## Web update failure

The sequence is download/authenticate → safe staging → maintenance → stop background
workers → native SQL and full file backup → preserve .env/storage/custom themes →
release switch (preserving the actual .env bytes) → build PHP runtime → forced migrations → clear caches → wait for
services → leave maintenance. Unmodified shipped themes update; user-added or modified
theme files are overlaid from the previous install. That can require manual merges
when a custom template conflicts with new application behavior.

Before migrations begin, an ordinary failure restores the original application files
and services. Once the migration invocation begins, **no automatic database rollback
or code rollback is attempted**. Even a failed migration may have partially changed
SQL Server state. Status becomes `migration-recovery-required`; automatic Start and
further web updates are blocked. The site remains in maintenance and old application
files remain under `previous-*` for manual inspection.

Have the SQL operator inspect migration state and choose either a forward fix or a
coordinated restore of the native SQL backup and matching site archive. Only after
that restore/fix, test migrations, PHP runtime, nginx and the site, leave maintenance,
and correct the private state version/phase to match the recovered installation.
Do not run `migrate:rollback` blindly. The manager does not invent a successful recovery
from partial SQL changes.

Update phases are persisted before disruptive work and before migration invocation.
A hard power loss can still leave a partially switched filesystem or active maintenance
file; an `updating` or `access-changing` phase requires manual inspection. Inspect the private backups, `previous-*` directories and database migration table
before using Start/Resume. This review version has no fully crash-atomic transaction
journal spanning Docker, filesystem and SQL.

## Explicit decommissioning

NSIS removes the panel only. Stop the project and export backups before separately
removing runtime data. The Windows task can be disabled/removed in Task Scheduler
(`MuOnline-Web-WSL`); certificate renewal uses `muonline-certificates.timer` in WSL.
SQL databases/logins, Docker volumes and Ubuntu are never deleted by NSIS panel uninstall.
No cleanup command here authorizes deleting a user's game data.

The source-only [dev reset](development-wsl.md) requires exact-name terminal
confirmation and removes only MuOnline-Dev and its dedicated Windows task. It
cannot undo changes to external SQL databases. Close the dev panel first; a shared
lock prevents reset/setup while that panel is running.

## Runtime uninstall from the panel

First installation contains a separate destructive runtime removal section. Check
status to display the saved SQL host/port, web database and dedicated application
login. The user confirms those SQL resources separately, supplies temporary SQL
sysadmin credentials, acknowledges permanent distribution deletion and types the exact
main-owned distribution name. A backup button opens the existing backup page; export
SQL and file backups off the runtime before proceeding. Game databases, game logins
and profile-added game schema are retained.

Main records an uninstall checkpoint, inventories its exact distribution and attempts
to copy redacted diagnostics to Windows-local support logs. Before task cleanup or
WSL unregister, the worker verifies saved targets against resolved Compose configuration,
records `uninstall-sql-pending`, and stops nginx/app/queue/scheduler. It runs:

```sh
docker compose --project-name muonline-manager --file /opt/muonline-web/compose.json run --rm --no-deps -T --entrypoint php app artisan app:database:uninstall --force --no-interaction
```

Arguments are arrays; one JSON object goes through private stdin, with host, port,
database, login, admin_username, admin_password and confirmed=true. Temporary credentials
are never written to a file, environment, saved state or argv. This requires an installed
web release containing the command; an older release is not silently bypassed. The
Laravel command independently verifies effective targets, protected identities, web
schema signatures and shared SQL resources before deleting anything.

A nonzero process exit, malformed/missing JSON, refusal, incomplete resource status,
or Docker failure retains the runtime and its configuration. The panel shows separate
web database/login progress in EN/BG and clears the password on success and failure.
SQL DDL is not transactional: a removed database is not automatically rolled back.
Services may remain stopped. Retry deinstallation after fixing the reported issue;
the Artisan command handles resources already absent. Automatic Start/update is blocked
while the private state has an uninstall phase. Manual SQL recovery must precede any
attempt to restore normal website operation.

Only exit 0 plus a validated success for both SQL resources records
`uninstall-sql-complete`. Task cleanup and `wsl --unregister` then run for the fixed
main-owned identity. If those Windows steps fail, retry reuses the saved successful
SQL checkpoint instead of issuing destructive SQL again. An empty runtime without
application/state files may be removed without SQL authorization; untracked application
files block this bypass. An already absent distribution can finish journal/task cleanup.

Unregister permanently removes all data in the distribution, including Docker volumes,
website uploads, certificates, backups and other workloads there. Other distributions,
shared Windows WSL features, the panel and Windows-local support logs are retained.
NSIS uninstall never invokes this operation automatically.

## Windows support logs

Use Logs / Open log folder to locate the named file shown after an error. The files
are in Electron userData/logs (`%APPDATA%\MuOnline-Web-Manager-Dev\logs` for dev).
They include operation timestamps, exit codes and redacted process diagnostics,
without request bodies, argv or stdin. Request/runtime passwords and common credential
fields are removed before writing. Logs may still contain technical/user information;
review them before sharing. They remain available after WSL removal. Recent files
are bounded/rotated (30 files, 2 MiB per file); export the relevant file before older
ones expire. The manager does not send support logs automatically.

Elevated Windows preparation writes a bounded result with its setup stage, exit code
and machine-setup error into a main-owned temporary JSON file. The non-elevated
coordinator checks the report against the process exit code, appends it to the
redacted support log as `Windows WSL setup: ...`, and removes the temporary directory.
The helper receives no SQL credentials. A missing report is labeled
`elevated-process`; unexpected nonzero exits cannot advance to distro installation.
On Windows PowerShell 5.1, native WSL stderr is captured with a local Continue error
preference and the native exit code is checked explicitly. A failing kernel updater
therefore reaches the signed MSI fallback instead of aborting via NativeCommandError.

The coordinator logs `Windows WSL setup coordinator: result-report-v2` before launching
PowerShell. Its outer try/catch returns a bounded `elevation-start`, `elevation-exit`
or `elevation-report` failure as JSON. After waiting it refreshes the elevated process
before comparing exit codes. If the coordinator itself fails without usable JSON,
main reads and logs any child report before removing the temporary directory; that
report is diagnostic only and cannot turn coordinator failure into readiness.

Install/Resume now prepares local SQL automatically before pending bootstrap. The
main-owned repair confirmation can replace loopback or a currently measured local
Windows address with the measured WSL gateway; endpoints not proven local retain
the explicit same-server confirmation boundary. A local SQL instance ID is kept in
private runtime state, allowing a pending install to rediscover the same instance
without switching SQL servers. Runtime passwords and APP_KEY remain stable. Changing
a bound instance or silently changing it to remote SQL is refused. Remote/cloud
SQL installations do not receive local firewall changes or instance bindings.

Existing ready installations are not retargeted by clicking Install, and this feature
does not change Start's behavior. A later WSL subnet change on an already completed
installation still requires diagnosis/configuration recovery; automatic ongoing
readdressing is not implied. Narrow rules can remain after a later failed bootstrap;
retry reuses them, and SQL effects are not automatically rolled back.


## Reboot and completion notices

The manager records the Windows boot timestamp (read-only Win32_OperatingSystem CIM)
when feature activation or modern WSL installation requires a restart. Retrying
Install/Resume in the same boot stops before WSL install/update; closing the manager
or removing runtime components does not clear the gate. A measured new boot clears
it and environment setup is rechecked. Invalid/unavailable boot identity fails closed.
No automatic Windows reboot is performed and temporary passwords remain ephemeral.

A dedicated dismissible restart dialog explains how to restart, reopen Manager and
Resume. A separate successful-install dialog appears only after a fresh installed
`ready` status: it shows a green check and X/Continue close controls, with Control
Panel already opened at the top underneath. The busy overlay retains its elapsed
timer and gives an approximate first-install duration of about 15 minutes, explicitly
dependent on machine/network speed; it is not a countdown or guaranteed deadline.

First launch uses the measured runtime state. New/incomplete setups start at First
installation with SQL Troubleshooting and Help available; optional tools can open
Control Panel for component maintenance. Ready deployments open Control Panel with
the full operational navigation and hide First installation. Uninstall's SQL target,
private credentials and irreversible confirmations live in its collapsed Control
Panel section. Failed status checks do not count as completed installation. The
three donation links remain visible below both busy and terminal dialogs.

A failed game bootstrap can follow a successfully created web database. Preserve the
pending deployment and its generated passwords/key. Resume reuses a currently reachable
bound local SQL endpoint without a redundant firewall mutation, but still verifies the
actual Docker TCP path. A game-specific bootstrap error directs the operator to the
existing game database, selected profile and temporary administrator permissions;
this message does not prove which of those failed and does not authorize database
replacement or password rotation. SQL diagnostics are read-only and remain accessible
from the incomplete-install view.

SQL Troubleshooting defaults to the private saved application/game connections even
for `bootstrap-pending` deployments. A bootstrap error carrying the saved endpoint
updates the panel immediately; no extra Status click or manual copy from `.env` is
needed. The WSL diagnostic process reads the container environment, or resolved
Compose settings when the app container has not been created. Passwords never fill
renderer fields. Manual connection inputs are hidden/disabled unless explicitly
selected for a separate advanced test. Optional temporary SQL administrator input
still requires re-entry, since bootstrap authorization is intentionally not retained.

Configured Mixed Mode without a readable live value is Not checked, not evidence
that another restart is required. Only a confirmed configured/live mismatch advises
a restart. Docker PDO facts may confirm the selected Windows instance only after
matching its measured address, listener port and owning service PID.

## Installation form choices across restarts

The installation form automatically saves its bounded public draft on edits, before
Install is clicked. It restores SQL host/port/admin username, database and restricted
login names, MuServer profile key, APP_ENV, certificate trust choice, access mode,
domain/IP, certificate email, HTTP acknowledgement and web administrator name/email.
Passwords are excluded both before draft IPC and again by the main process. The
endpoint-change confirmation is never remembered. SQL diagnostic/manual and backup
passwords are not part of this installation draft.

Public fields survive navigation, manager reopening and Windows reboot. Signed
release discovery restores the selected profile after its options arrive; it must
not reset the selection to the first profile while loading. Initial preferences
must not be overwritten with the blank form captured before startup restoration.
Draft writes are coalesced and completed before another backend operation. A failed
save shows a localized notice; retry before closing. Full runtime uninstall clears
the draft, while component recovery retains it.

A saved SQL IP is a draft, not proof of current reachability. Install/Resume still
measures a local Windows SQL endpoint and, for a bound interrupted deployment,
rediscovers that same instance after a WSL gateway change. Verified replacements
are saved back to the draft. External SQL endpoints are not silently redirected;
an externally changed IP must be corrected by the operator. Ready deployments are
not automatically retargeted by editing an installation draft.
