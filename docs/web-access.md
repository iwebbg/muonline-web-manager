# Web access, Laravel nginx and Windows forwarding

Domain + SSL uses the nginx production implementation **inside the authenticated
web release**, rather than manager-owned certificate issuance/template code:

- `docker/nginx/prod/Dockerfile`
- `docker/nginx/prod/default.conf.template`
- `docker/nginx/prod/startup.sh`
- `docker/nginx/prod/certbot-renew.sh`

The manager builds that Dockerfile, passes `APP_DOMAIN` and the supplied
`NGINX_SSL_EMAIL` as container environment, and mounts the deployed application read
only. The mount serves the release's existing `public/build`, uploads and preserved
custom themes. The Dockerfile also has its normal frontend build stage; Node/npm
are build dependencies of that stage, not running services or site dependencies.
No manager copy of the release's shell scripts/template is bundled or substituted.
A missing production nginx contract stops Domain configuration before changing the
existing site. Release packaging now requires these files. Existing signed archives
must be inspected for them; a GitHub tag alone is insufficient and no automatic
source checkout or unsigned fallback is used.

Laravel startup obtains the first domain certificate with standalone Certbot on
port 80, renders its template, starts cron and then nginx. Existing domain-specific
certificate files are reused. The release's renewal script runs webroot renewal and
its nginx deploy hook. Persistent `acme/`, `certificates/` and `nginx-logs/` directories
survive container recreation, access switches and web updates. Cron continues when
the manager is closed, provided Windows/WSL/Docker remain running.

Local and IP retain the previous HTTP proxy configuration and PHP/Redis lifecycle.
Local publishes WSL loopback port 80; IP publishes port 80 on WSL interfaces. The
production Compose file is not imported wholesale: APP_ENV remains independent of
access mode, the existing SQL/bootstrap boundaries remain, and the manager retains
its verified-release/update/backup coordinator. Domain publishes WSL ports 80/443.

## Transition and recovery

Before an access switch, exact state/Compose/.env/nginx bytes are backed up. A
Domain image is built before stopping the previous nginx, so build failures leave
the old proxy available for restoration. The previous nginx is stopped before
standalone Certbot needs port 80. PHP/config cache preparation finishes before the
first Domain nginx container starts; no force-recreation interrupts its initial
certificate request before the health wait. The first challenge container temporarily uses
`restart: no` so a refusal cannot repeatedly contact the CA in a restart loop. Only
after its first health/syntax success is normal `unless-stopped` behavior restored
and rechecked using the existing certificate. Only after success is the legacy `muonline-certificates.timer` disabled;
new installs do not create that timer or a separate certbot service.

On refusal, nginx container logs are captured through the existing private redacted
support logger before the previous container/configuration is restored. Legacy
Compose files are restored exactly, including their old certbot service/timer where
applicable. Certificates are not deleted. Initial failure remains resumable rather
than claiming rollback to a working HTTPS site. A pending installation may explicitly
resume with corrected access settings, including Local. Web updates build the release
nginx image for Domain mode and retain original configuration bytes for pre-migration
recovery; database migration rollback remains manual.

An already-ready legacy site is not reconfigured just by opening the new manager.
Apply Domain + SSL again (or perform an explicitly requested compatible web update)
to migrate it. If an interrupted installation lacks the required files, explicitly
Resume in Local mode, update to a compatible signed web release, then apply Domain. Keep the existing backup until the new public HTTPS path is verified.

## Windows/WSL boundary

Docker port publishing inside WSL is not a guarantee of Windows LAN accessibility.
For measured WSL NAT networking, `runtime/web-network.ps1` prepares:

| Mode | Manager-owned Windows exposure |
| --- | --- |
| Local | No public web proxy/firewall rule; remove prior owned web configuration |
| IP | TCP 80 to the selected distribution's current default-interface IPv4 address |
| Domain | TCP 80 and 443 to that measured IPv4 address |

The selected distribution is main-owned: Ubuntu-24.04 or the separate MuOnline-Dev
profile. Only a unique private IPv4 address on the actual default interface is
accepted. Mirrored or unknown networking fails closed with an explicit message;
this helper never changes global WSL networking settings or opens all Hyper-V ports.
Router NAT, public DNS, CGNAT/provider filtering and Cloudflare origin routing remain
external prerequisites. HTTP-01 needs public port 80 for issuance and renewal.
A Cloudflare proxy/redirect configuration must permit the challenge to reach the
bootstrap HTTP listener; an origin-HTTPS-only path before the first certificate is
issued can still fail. The manager does not change Cloudflare settings.

Preparation uses UAC and argv arrays. Only mode/profile enter its temporary JSON
request; no domain, SQL identity, password, arbitrary command or port is forwarded.
Existing non-manager proxies, foreign listeners and rule/task name collisions are
refused before mutations. Firewall rules use the fixed TCP ports with `LocalAddress Any` and `RemoteAddress Any`
for the selected public mode. `0.0.0.0` is only the portproxy listen address; it must
not be used as the firewall local-address filter. Windows was observed normalizing
`0.0.0.0/0` to the literal `0.0.0.0`, which did not match the Windows LAN address.
Exact direction, port, protocol and address filters are verified in ActiveStore
after creation and on refresh. Existing incorrect owned filters are repaired.
A matching owned proxy can be hosted by System or the currently running IP Helper
service PID; a fixed PID is not assumed. Foreign listener ownership is still refused.
The helper may start Windows IP Helper (`iphlpsvc`) for
portproxy; it does not disable Windows Firewall, rewrite unrelated rules, or expose
SQL. Existing WSL localhost relay listeners are distinguished from foreign services.

Owned state and refresh code reside under the OS-resolved Program Files directory:
`MuOnline-Web-Network` or `MuOnline-Web-Dev-Network`. The directory must not be a
reparse point or owned by an unrelated user; its ACL permits Administrators/SYSTEM
writes only. The elevation source is copied there, never executed by a privileged
scheduled task from a user-writable app directory. Task ownership, path and action
are checked before replacement. The task runs as the same interactive user at the
highest run level, with no stored password or SYSTEM principal, at logon and every
two minutes. It remeasures the target and updates only matching owned proxies. This
is not a guarantee of service before user login or during Windows sleep/shutdown.

Start, Restart and web Update also refresh previously configured public forwarding.
A current-user `web-network.json` records only mode/pending state before elevation.
Interrupted/refused preparation cannot silently enable public ports through a later
background refresh; retry Install/Access explicitly. A successful access/install
transaction returns a network recovery ticket. Runtime refusal restores the prior
network mode; a second failure explicitly requires inspecting owned forwarding.
Local switches and full runtime uninstall remove owned forwarding, rules and the
refresh task. SQL cleanup still precedes full WSL unregister. Partial firewall
mutation failures attempt restoration, and ownership drift blocks destructive cleanup.

## Verification

`npm test` includes safe Node boundary tests and mocked PowerShell contracts on
Windows CI. `tests/windows-web-contract.ps1` never invokes real netsh/firewall/WSL
commands. It also runs in the existing PowerShell Linux image with all OS effects
mocked. Native Windows networking/UAC/Task Scheduler acceptance is still required.

With existing local `nginx:1.29-alpine` and PowerShell Ubuntu images:

```sh
python3 scripts/check-laravel-nginx.py --source ../muonline-web-laravel
```

This script uses `--pull never`, no container network and no published host ports.
It checks the real release template with a disposable self-signed certificate,
HTTP-01 file response and HTTPS health. It runs the unchanged startup/renew scripts
with stubbed ACME/daemon commands to verify first issuance, certificate reuse, cron
start and renewal hook arguments. It neither obtains a real certificate nor proves
the public Windows/router/Cloudflare route.

Acceptance should cover Domain first install, Local→Domain, Domain→Local/IP, changed
domain, existing certificate reuse, UAC denial, occupied port 80/443, failed ACME,
reboot/address refresh with the panel closed, full uninstall cleanup, and renewal.
Recheck Local/IP on the four supported test OS variants; do not infer these passed
from the previous build's VM results or the isolated Linux tests.
