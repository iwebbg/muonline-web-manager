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
A kernel-only update is insufficient: if modern flags remain absent, setup retains all
distros and asks for Windows updates and current Microsoft Store WSL. It never falls
back to WSL1 or an interactive distro installer. Retry Install after updating WSL.
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
is still pending; other SQL settings and generated runtime passwords come from the
saved private state. Re-enter administrator details only if the phase has not passed
that step. Resume does not rotate APP_KEY or regenerate runtime SQL passwords.

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
