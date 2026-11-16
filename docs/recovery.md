# Operations and recovery

The runtime data directory is private and contains credentials. Backups are private
as well. Use WSL root to inspect it; do not paste .env/state.json into issue reports.
Never use `docker compose config` output in public logs: it can contain resolved secrets.

The fixed project command inside Ubuntu-24.04 is:

```sh
docker compose -p muonline-manager -f /opt/muonline-web/compose.json ps
```

Start/Stop/Restart in the panel operate on this project. Stop keeps containers, volumes,
site data and SQL databases. Closing the panel does not stop Docker. The user logon
keepalive task does not make Windows an always-on server before login or during sleep.

## Interrupted initial installation

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

## Failed access changes

Each change saves state.json, compose.json, .env and nginx.conf under
`backups/access-<timestamp>-<nonce>/`. Ordinary validation failures change nothing.
Runtime/ACME/health failures restore the previous generated configuration and recreate
the services. An explicit error identifies when recovery also failed. Inspect the
private backup and DNS/ports, then restore matching state/.env/Compose/nginx files
and restart the project. Preserve certificate directories; they are domain-specific.
APP_ENV and APP_KEY are never changed by an access switch.

Initial SSL setup has no prior working SSL configuration; it keeps the incomplete
installation state and offers resume instead of claiming a successful rollback.

## Backups

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
release switch → build PHP runtime → forced migrations → clear caches → wait for
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
SQL databases/logins, Docker volumes and Ubuntu are never deleted by panel uninstall.
No cleanup command here authorizes deleting a user's game data.
