# Architecture

The NSIS installer installs a persistent Electron control panel. The panel then
checks/sets up WSL2, Ubuntu-24.04, Docker Engine, and the application. The installer
and the Linux runtime have independent lifecycles. NSIS uninstall does not destroy
SQL databases, WSL site data, certificates, backups or the keepalive task.

Source-only `npm run dev` selects the fixed MuOnline-Dev distribution and
MuOnline-Web-Dev-WSL task, with separate Electron preferences. Worker invocation,
release path conversion and SQL diagnostics all receive the same main-owned
profile. No renderer field or saved preference selects a distribution. The normal
launch retains Ubuntu-24.04. See [development WSL](development-wsl.md) for setup,
confirmed reset and shared Windows/SQL resource boundaries.

## Trust and process boundaries

`src/main/main.js` creates one sandboxed, isolated renderer. Node integration is off;
CSP prevents remote scripts, network access, frames and form navigation. Navigation,
popups and permissions are denied. IPC checks the exact main frame, webContents and
file URL, bounds payload size, and dispatches an operation allow-list. External links
are restricted to fixed company, GitHub project/issue, support email and donation
destinations in `src/shared/links.js`. Opening an issue/email composer never sends
a report automatically or attaches runtime configuration.

Open Website / Open Admin Panel are separate fixed IPC actions. Main rereads installed
status on each click, requires completed installation, validates a plain HTTP(S) origin
without credentials/query/fragment and opens only that origin or its fixed `/admin` path
in the default browser. Renderer-provided URLs/paths are ignored. Local mode opens
`http://localhost` and `http://localhost/admin`; IP/domain modes follow saved access
configuration. The buttons remain disabled until a successful installed-state check.

The preload exposes named operations, not a shell, filesystem API or raw ipcRenderer.
Main invokes `wsl.exe` with fixed argv and sends a packaged Python worker plus JSON
on stdin. Python dispatches a fixed operation list and invokes subprocess argv arrays.
No user SQL host, domain, password or profile becomes shell code. Two fixed packaged
shell scripts prepare Python on Ubuntu 24.04 and install Docker's official APT
repository/packages. Linux account/systemd preparation belongs to worker.py.

Install and Resume now share a desktop setup coordinator: WSL distribution, Linux
account/systemd, Docker, keepalive, then application installation/resume. The desktop
`installation.json` records the current stage before effects, its completion/failure,
the Linux username and a bounded public form draft. It never contains temporary SQL
or administrator credentials, command output or exception text. Completed effects
are re-measured before retry: a healthy Docker Engine is reused. The worker's private
application phases remain authoritative for bootstrap/admin/SSL recovery.

Ubuntu is accessed using explicit `-u root --exec` rather than opening an interactive
shell/user wizard. The worker creates a fixed `muonline` account with useradd's locked
password default, preserving an existing account/password. No Linux password is
generated or stored. Manual access uses the saved distro/username and Windows
identity: `wsl -d <distribution> -u muonline --exec /bin/bash`. If systemd needs enabling,
the original wsl.conf is retained privately and only the selected distribution is
terminated/restarted. Windows UAC/reboot remains an explicit OS boundary; secrets
must be supplied again after the panel restarts. `setupStatus` is a read-only IPC
endpoint that remains available during an install for public progress display.

The worker runs as root in the user's WSL distro. This is a privileged local deployment
manager, not a sandbox against the Windows account owner or WSL root. Runtime state
and .env contain runtime SQL passwords and APP_KEY, are private, and are excluded from
IPC status responses. Temporary SQL bootstrap secrets live in a private /dev/shm file
only around a one-shot bootstrap container and are removed in `finally`. Backup SQL
credentials cross only stdin to PHP and are never archived. Subprocess stderr and
failed-command output are withheld because dependencies may echo connection strings.
Runtime subprocess diagnostics are recorded with known request/runtime passwords,
bootstrap authorization, APP_KEY and common credential fields/URI authentication
redacted. Neither argv nor stdin is recorded. Main forces the recording policy;
renderer fields cannot switch it off or select a log path. Bounded root-private
WSL JSONL logs are relayed to Windows-local per-operation support files under
Electron userData/logs in both normal and dev modes. Windows process stdout/stderr
is captured only through this redacting logger. Thirty files up to 2 MiB each are
retained; inputs and secrets remain in memory only. User-facing errors stay short
and identify a support filename; Logs opens the local folder. The dev CLI can still
read WSL diagnostics. Local files survive removal of the runtime distribution.
The log endpoint redacts known runtime secrets and common credential fields, but logs
still contain operational/user information and should not be shared publicly.

Runtime removal is a separate explicitly confirmed action. It exposes the saved SQL
endpoint/database/login through status, passes temporary sysadmin authorization only
through private stdin, and stops nginx/app/queue/scheduler before the installed
`app:database:uninstall --force --no-interaction` command. A one-shot PHP container
bypasses the bootstrap entrypoint. Only verified complete SQL success allows WSL
unregister; pending/completed private checkpoints protect retries and block normal
Start/update. Game SQL resources remain. See [recovery](recovery.md#runtime-uninstall-from-the-panel).

## Linux layout and lifecycle

`/opt/muonline-web/` contains `application/`, `compose.json`, `nginx.conf`, private
`state.json`, `backups/`, `staging/`, `acme/` and `certificates/`. Worker mutations use
an advisory exclusive lock. Main serializes operations and prevents closing the window
while one runs. Killing the process or Windows reboot can still interrupt an operation.

Compose project `muonline-manager` reuses `docker/php/Dockerfile` target `development`
as the PHP 8.5 base with ODBC/sqlsrv/Redis extensions, then mounts the prebuilt runtime.
The development target name describes the image build stage; APP_ENV comes from the
site configuration and can be production. Composer is present in the image but is not
needed at runtime because vendor is shipped. There is no frontend container or runtime
Node.js. PHP processes run as www-data; nginx sees a read-only application mount.
`app`, `queue`, `scheduler`, `nginx` and Redis use `restart: unless-stopped`.

Docker is enabled under WSL systemd. The current user's Windows scheduled task
`MuOnline-Web-WSL` runs `wsl.exe ... sleep infinity` through a hidden waiting
PowerShell host (both wrapper and child use Hidden), and is started at logon/immediately
after Docker setup, before deployment, and on explicit Start. This also covers an
already-installed Docker Engine. This is needed because WSL systemd services alone do not guarantee
that WSL stays alive. The scheduled task runs only in that user's logon context. It
is not a promise of unattended pre-login hosting. Windows shutdown/sleep, manually
terminating the task, or `wsl --shutdown` interrupts the runtime. Task restart and
Docker restart behavior must be checked on Windows.
Task registration replaces a running legacy direct-wsl action by stopping that task
first; otherwise IgnoreNew would retain its visible console. The child remains
attached to the waiting task rather than being detached from Task Scheduler.

## Laravel integration

The registry is read from the release's real `config/game.php` `version_profiles`
block. Manifest keys must match that block at staging. No legacy adapter is changed.
The restricted login/bootstrap behavior comes from the existing PHP entrypoint:

1. `app:database:install` creates the isolated website database and runtime identity.
2. `game:database:install` provisions restricted access to an existing game database.
3. The entrypoint runs `game:install-profile-schema` for DarksTeam 1.0M only.
4. `migrate --force` and the existing bootstrap seeding behavior run.
5. A clean runtime container starts without temporary credentials; `admin:create`
   receives its four answers through private stdin. Before installation finishes,
   game:doctor must pass the schema and least-privilege checks.

Game writes are disabled by default. `game:doctor` expects those safety switches to
remain closed. Administrator listing/update/deactivation/password reset use the current Laravel
`admin:list`/`admin:update` JSON contract. The confirmed deletion operation uses
`admin:delete --force`; the UI favors deactivation. See [administrator management](administrators.md)
for private stdin, response filtering and the required web release. SQL backup does not call the
SQLite-only `app:backup` command.

The overview exposes a confirmed game-write switch. `setGameWrites` accepts only a
boolean target, explicit restart confirmation and the last measured mode. The worker
reads the actual dotenv flags, rejects stale requests and requires phase=ready. It
backs up exact .env/state bytes, updates only GAME_DB_READONLY/GAME_WRITES_ENABLED,
clears Laravel config using a one-shot PHP command that bypasses bootstrap, and
recreates the entire Compose project with health waiting. A plain Docker restart
does not reload env_file. This changes no SQL permissions and runs no migrations.
Intentional write enablement does not bypass game:doctor's read-only safety policy.

Service cards normalize only known Compose fields, distinguish running/health states
and expand for details. The overview refreshes measurements every 15 seconds while
visible and idle. Background reads cannot apply changes, replace a newer operation's
result or silently reset an unsubmitted write selection. Mutations show busy state;
write changes are never applied just by moving the switch.

## Access modes

| Mode | Binding | URL / cookies | Intended usage |
| --- | --- | --- | --- |
| Local | WSL loopback port 80 | http://localhost, secure cookie false | Testing |
| IP | All WSL interfaces port 80 | HTTP IP, secure cookie false | Explicit HTTP warning; testing or production choice |
| Domain + SSL | WSL ports 80/443 | HTTPS domain, secure cookie true | Recommended production |

APP_ENV is independent. Session domain is null (host-only); HttpOnly and SameSite=Lax
are explicit. A domain/email is validated before writing nginx config. HTTP-01 uses
a webroot, certificates have domain-specific directories, and a systemd timer renews
certificates twice daily and reloads nginx. Port-80 ACME access is required for renewal.

Every access switch backs up state/.env/Compose/nginx config, changes only the access
keys in an existing .env, recreates containers,
clears Laravel config cache, checks nginx and waits for health. Failed changes restore
the exact previous configuration files. If recovery itself fails, the error identifies
the backup and an access-recovery-required phase prevents automatic Start/update.
Old certificates remain private for recovery. Public DNS, host firewall and router NAT
are not silently changed; Windows forwarding, LAN/public reachability and real ACME
issuance require end-to-end acceptance checks.

## Interface languages

The panel supports `en` and `bg`. It starts with the OS locale (Bulgarian for bg
locales, English otherwise) until the user chooses a language in the header. The
strictly validated `setLanguage` IPC action saves only the preference alongside the
public feed settings in the Electron userData directory. Feed settings and WSL
application APP_ENV are independent of the panel language. Existing settings files
without a language continue to work. Changing language preserves unsent form values
in memory and does not persist credentials or invoke a deployment operation.

Application text lives in `src/shared/locales/{en,bg}.js`; known operational messages
are translated at the presentation boundary in `src/shared/messages.js`, preserving
recovery paths and technical identifiers. Native Electron menus/dialogs use the same
language. SQL diagnostic reasons/actions/statuses are localized from typed results; measured
technical evidence, process logs and unknown third-party errors retain their original text. Browser form validation messages are localized as well.

NSIS provides a separate English/Bulgarian installer language selector. Custom
welcome/support pages and missing upstream Bulgarian installer messages are translated
in build/installer*.nsh. Installer language and the saved panel preference are separate.

## Application version discovery

`latestGithubTag` reads the public GitHub tags API, accepts stable `vX.Y.Z`/`X.Y.Z`,
scans pagination and chooses the numeric highest version. `discoverWebRelease` then
authenticates only that version's CDN manifest/signature. GitHub is an announcement
source; it is not a trust key or a source archive download endpoint. A missing latest
runtime never causes installation of an older tag.

Main reads the installed application version/phase from WSL, compares it to the signed
latest version, and reports availability separately from a merely discovered tag.
Install discovers afresh without requiring a prior manual feed check. Update also
checks afresh; successful runtime provisioning persists version state before returning
success. The renderer refreshes status and availability after installation/update.
The Updates screen has a notification and version summary; source prefixes/key names
are not part of normal user setup. Manager updates continue to use their independent
signed feed. CDN override is retained under advanced settings.

## SQL Troubleshooting boundary

[SQL Troubleshooting](sql-troubleshooting.md) uses a dedicated packaged read-only
Python helper and PDO probe, coordinated with Windows inventory in the main process.
It does not dispatch arbitrary worker operations. Six narrow IPC methods expose
instance inventory, diagnosis, preview, confirmed apply and server-owned report/command
copying. The clipboard endpoint cannot copy arbitrary renderer-provided data.

The existing worker remains responsible for deployment and database changes. Diagnostic
containers bypass its bootstrap entrypoint, inspect independent connections, and do not
create databases. Windows changes use expiring main-owned plans, fresh measurement,
explicit confirmation and UAC. Their limited elevated helper re-resolves the selected
instance and never receives SQL passwords. See the module documentation for firewall
scope restrictions, metadata visibility and real-Windows validation limits.

Windows feature/modern-WSL preparation elevates the fixed packaged
`runtime/setup-windows-wsl.ps1` using `-File`. A small fixed PowerShell wrapper receives
the main-owned resource path through UTF-8 JSON stdin, validates and quotes the path,
and waits for UAC/exit status. The installer source is never nested inside encoded
command arguments: double encoding exceeded Windows' command-line limit before UAC
could launch. Spaces and Cyrillic installation paths remain data, not script source.

The installer adds a journaled `sqlNetwork` step for pending first-install bootstrap.
The editable SQL host is classified against measured Windows adapters. Only proven
local targets are replaced by the measured WSL gateway; external hosts are preserved.
Main owns the automatic firewall request and local instance binding, overwriting any
renderer-supplied binding. The elevated packaged SQL helper receives public metadata
only. The worker validates bindings and probes the real application container's TCP
path before credentials enter SQL bootstrap. See SQL Troubleshooting/recovery for
scope checks, pending-only repairs, UAC and native Windows acceptance requirements.
