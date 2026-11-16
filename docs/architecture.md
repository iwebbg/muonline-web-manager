# Architecture

The NSIS installer installs a persistent Electron control panel. The panel then
checks/sets up WSL2, Ubuntu-24.04, Docker Engine, and the application. The installer
and the Linux runtime have independent lifecycles. NSIS uninstall does not destroy
SQL databases, WSL site data, certificates, backups or the keepalive task.

## Trust and process boundaries

`src/main/main.js` creates one sandboxed, isolated renderer. Node integration is off;
CSP prevents remote scripts, network access, frames and form navigation. Navigation,
popups and permissions are denied. IPC checks the exact main frame, webContents and
file URL, bounds payload size, and dispatches an operation allow-list. External links
are restricted to the three donation URLs.

The preload exposes named operations, not a shell, filesystem API or raw ipcRenderer.
Main invokes `wsl.exe` with fixed argv and sends a packaged Python worker plus JSON
on stdin. Python dispatches a fixed operation list and invokes subprocess argv arrays.
No user SQL host, domain, password or profile becomes shell code. The only setup shell
script is a packaged fixed script for Ubuntu 24.04 and Docker's official APT repository.

The worker runs as root in the user's WSL distro. This is a privileged local deployment
manager, not a sandbox against the Windows account owner or WSL root. Runtime state
and .env contain runtime SQL passwords and APP_KEY, are private, and are excluded from
IPC status responses. Temporary SQL bootstrap secrets live in a private /dev/shm file
only around a one-shot bootstrap container and are removed in `finally`. Backup SQL
credentials cross only stdin to PHP and are never archived. Subprocess stderr and
failed-command output are withheld because dependencies may echo connection strings.
The log endpoint redacts known runtime secrets and common credential fields, but logs
still contain operational/user information and should not be shared publicly.

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
`MuOnline-Web-WSL` runs `wsl.exe ... sleep infinity` at logon and is started immediately
after Docker setup, before deployment, and on explicit Start. This also covers an
already-installed Docker Engine. This is needed because WSL systemd services alone do not guarantee
that WSL stays alive. The scheduled task runs only in that user's logon context. It
is not a promise of unattended pre-login hosting. Windows shutdown/sleep, manually
terminating the task, or `wsl --shutdown` interrupts the runtime. Task restart and
Docker restart behavior must be checked on Windows.

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
remain closed. There is no invented CLI command for admin listing/deactivation/reset;
only the existing `admin:create` operation is exposed. SQL backup does not call the
SQLite-only `app:backup` command.

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

Every access switch backs up state/.env/Compose/nginx config, recreates containers,
clears Laravel config cache, checks nginx and waits for health. Failed changes restore
the previous configuration. If recovery itself fails, the error identifies the backup.
Old certificates remain private for recovery. Public DNS, host firewall and router NAT
are not silently changed; Windows forwarding, LAN/public reachability and real ACME
issuance require end-to-end acceptance checks.
