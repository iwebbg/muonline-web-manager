# SQL Troubleshooting / SQL диагностика

The panel's **SQL Troubleshooting** page supports English and Bulgarian. It diagnoses
Windows SQL Server, WSL networking and the application's actual Docker network as
separate layers. Running diagnostics does not change services, registry, firewall,
application configuration or databases. It can start a disposable read-only diagnostic
container using an existing runtime image; it never builds or pulls one automatically.

## Using the panel

1. Choose **Discover instances**, then the local default or named SQL instance. The
   selected service and version appear in the inventory/results. A remote SQL endpoint
   can be tested too; its Windows registry/service settings cannot be inferred from
   this machine's local instances.
2. For an existing deployment, select **Use installed application settings**. Host,
   port, TLS and runtime credentials come privately from the actual app container's
   environment, with resolved Compose settings as fallback. Manual fields do not
   override that deployment. Before installation, enter the proposed host, port,
   database names and runtime SQL identities instead. Optional ranking/BattleCore
   databases can be checked independently.
3. Optional bootstrap authorization is temporary. Game administrator username and
   password independently fall back to the application administrator values, matching
   Laravel's `GAME_DB_ADMIN_*` behavior. No authorization is saved to preferences.
4. Run diagnostics. Results show **Passed / Warning / Failed / Not checked**, a cause,
   measured evidence and a concrete next action. **Retest** reruns the read-only suite;
   it does not retry a system mutation. Password fields are cleared after submission.
5. **Copy diagnostic report** copies the main process's redacted report, with localized
   explanations. The report includes addresses, login/database names and version facts;
   review these operational details before sharing it. Raw PDO exceptions, credential
   connection strings and subprocess stderr are withheld.

SQL operations need Windows with WSL2. Linux desktop development supports the panel
preview and isolated tests, but does not pretend to inspect Windows services.

## Interpreting results

| Layer | Evidence / limits |
| --- | --- |
| Instance | Registry64/Registry32 instance mapping, exact SQL service/PID/state and configured version; optional read-only local shared-memory Windows authentication obtains live version/authentication facts |
| Authentication | Configured Mixed Mode is distinct from the live `IsIntegratedSecurityOnly` value; pending restart, disabled login and explicit `CONNECT SQL` denial are distinct. Limited metadata visibility remains Not checked. Error 18456 alone does not prove a bad password; inspect the SQL Server error log |
| TCP | Enabled / Listen All / IPAll or individual enabled IP sections; dynamic `0` is not an empty value. Listener address/port/PID is matched against the selected service, including conflicts with another instance/process |
| Windows | Node sockets test loopback, LAN, observed WSL gateway and requested target; no shell command is constructed from a host |
| WSL | `wslinfo --networking-mode`, measured IPv4 addresses/prefixes and default routes, plus socket tests. Unknown mode remains Not checked. NAT gateway, LAN and mirrored localhost are tested separately |
| Firewall | Profiles and manager-owned/explicit-port rules are inspected. Matching Windows success plus WSL failure indicates firewall **or routing**, not proof of a particular blocked rule |
| Docker | Image ID, actual app network and container environment are resolved even when app is restarting. A one-shot `php` entrypoint bypasses bootstrap, with read-only filesystem, dropped capabilities and bounded resources. TCP precedes PDO/sqlsrv |
| TLS | Weak keys/legacy signatures, certificate trust/name failures, protocol/handshake errors and SQL authentication failures are classified separately. TrustServerCertificate is a visible test-environment concession, not a solution for obsolete cryptography |
| Databases | Application, game, configured ranking and enabled BattleCore connections are independent. Temporary bootstrap checks target master to inspect database existence/access. Missing game databases require restore/import; diagnostics never create empty databases |
| Runtime permissions | Own login enabled status, CONNECT SQL, database access and broad sysadmin/db_owner privileges are checked separately. A successful connection alone does not certify all adapter permissions; installed `game:doctor` runs read-only in an isolated container after game PDO succeeds |

The installed ranking connection follows `GAME_RANKING_CONNECTION=ranking`;
BattleCore follows the real enable flag. Enabled-but-missing configuration is explicit.
Laravel `DB_URL` overrides or a non-sqlsrv driver are reported as Not checked rather
than testing a different connection and claiming success. Docker's host-gateway and
`host.docker.internal` are never assumed to be the Windows SQL host.

For Mixed Mode use SSMS → server Properties → Security → SQL Server and Windows
Authentication mode, then restart the correct instance. For `sa`, Security → Logins
→ sa → Properties → Status controls Enabled/Grant; **General** resets its password
inside SSMS. The manager does not retain or log it. `sa` belongs only in temporary
bootstrap fields; the site uses separate restricted runtime logins.

For TCP use SQL Server Configuration Manager → SQL Server Network Configuration →
Protocols for the selected instance → TCP/IP. With Listen All=Yes use IPAll;
otherwise inspect the enabled IP sections. Set TCP Dynamic Ports to **empty, not 0**,
and set the intended static TCP port. Restart the matching SQL service separately.
SQL Server Browser is optional for a direct host + static port connection.

## Explicit Windows changes

Mixed Mode, static TCP configuration, a narrow firewall rule and SQL service restart
are separate actions. **Preview** only reads facts. It shows the exact instance,
before/after settings, scope and a copyable one-line PowerShell command. A confirmation
checkbox and **Apply** are required before Windows UAC. Restart warns that active SQL
sessions disconnect; it is never implicit after a registry change. Running dependent
services prevent the automatic restart.

Plans are main-process owned, single-use and expire after five minutes. Applying
refreshes instance/PID/configuration and WSL network facts, then elevation checks the
instance and relevant settings again. Stale plans require Retest and a new preview.
User values and passwords never become shell source. Trusted packaged PowerShell
is sent with structured stdin; elevated temporary files contain public plans only,
not SQL credentials. They are removed after the action finishes.

Automatic firewall proposals are limited to a **measured private IPv4 NAT subnet**:
the WSL default gateway must match a virtual Windows adapter, and both measured prefix
lengths/subnets must agree. No prefix is guessed from the gateway. Mirrored/unknown
modes, missing measurements, occupied/unverified listener ports or incomplete rule
inventory cannot produce an automatic rule. Rules restrict LocalAddress,
RemoteAddress and the selected TCP port; they never use an Internet-wide remote scope.
Equivalent exact manual rules are detected, manager rule names are deterministic and
existing matching rules are reused. Stale manager scopes are reported, not silently
removed. Policies with ranges, custom conditions, GPO or Hyper-V filtering still need
operator review and end-to-end tests; adding an allow rule does not override a deny.

TCP multi-value registry writes attempt to restore their prior values on failure and
report recovery failure explicitly. These changes do not provide database recovery
or migration rollback. Failed UAC/partial operations need fresh diagnosis; do not infer
success from the preview or the command being copied.

## Developer verification

```sh
npm test
# Graphical desktop or Xvfb required:
npm run test:ui
# Disposable Docker-only SQL 2022/PDO integration (existing PHP/sqlsrv image required):
npm run test:sql-troubleshooting
# Windows PowerShell, OS cmdlets mocked; does not change Windows settings:
powershell -NoProfile -NonInteractive -File tests/windows-sql-contract.ps1
```

The disposable integration creates an internal Docker network with no published SQL
port and deletes its containers/network afterward. It covers application success,
game 18456, independent bootstrap fallback, database access denial, missing game DB,
certificate trust failure and no diagnostic database creation. Legacy TLS error
patterns are exercised in the real PHP classifier; an actual SQL 2008 R2 handshake
is **not** part of this fixture. It never downgrades global OpenSSL policy.

Local Linux evidence: 36 Node + 24 Python tests, all seven Electron pages in EN/BG,
real PDO/SQL Server 2022 integration and PowerShell execution with mocked OS cmdlets
passed. This is **not** evidence that Windows registry, CIM/NetSecurity, UAC or service
changes work on an actual Windows host. The Windows CI workflow runs contracts and
builds NSIS; the Windows VM acceptance below remains required.

## Windows VM acceptance

Use snapshots and restored disposable databases, with WSL2 nested virtualization
available to the VM. Do not use live game databases for mutation/restart tests.

- Test default and SQLEXPRESS together, static/dynamic ports and a foreign listener.
  Verify inventory/PIDs, exact service selection and that another instance is untouched.
- Test Windows-only, configured Mixed Mode awaiting restart, enabled/disabled/denied
  logins, 18456 with limited metadata, SSMS password reset and Cyrillic Windows paths.
- Exercise Listen All Yes/No, IPAll/per-IP changes, UAC acceptance/cancellation,
  dependent-service refusal and restart interruption warnings. Confirm dynamic field
  becomes empty and the listener moves only after the explicit correct-service restart.
- In NAT and mirrored modes compare actual Windows/WSL/Docker socket measurements.
  Verify current prefixes, a failed route, host.docker.internal resolution failure and
  WSL address changes after restart. Unknown mode must not fabricate a NAT scope.
- Preview/apply firewall changes once and twice, with existing manual equivalent rules,
  disabled/changed own rules, deny/GPO rules and partial inventory. Verify no broad
  rule, duplicates or automatic stale-rule deletion; changed network invalidates plans.
- Put app in a restart loop; verify one-shot diagnostics still use its image/network
  and exact environment without running entrypoint/bootstrap or changing databases.
- Test supported SQL Server with valid hostname/certificate and self-signed certificate,
  failed TCP, actual legacy TLS if available, successful app but failed game login,
  restored/missing ranking/BattleCore DBs and excessive/restricted runtime permissions.
- Copy both language reports and inspect all UI/logs/temporary files for credentials.
  Keep the permanent three-link donation footer visible on the SQL page too.

## Microsoft references checked

- [Change authentication mode](https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/change-server-authentication-mode)
- [Configure a specific TCP port](https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/configure-a-server-to-listen-on-a-specific-tcp-port)
- [SQL Server error 18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error)
- [WSL networking and mirrored mode](https://learn.microsoft.com/en-us/windows/wsl/networking)
- [ODBC driver version differences](https://learn.microsoft.com/en-us/sql/connect/odbc/major-version-differences?view=sql-server-ver17)
- [SQL connection/TLS troubleshooting](https://learn.microsoft.com/en-us/troubleshoot/sql/database-engine/connect/error-message-when-you-connect)
- [SQL Server Browser](https://learn.microsoft.com/en-us/sql/tools/configuration-manager/sql-server-browser-service?view=sql-server-ver16)
- [New-NetFirewallRule](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule?view=windowsserver2025-ps),
  [Get-NetFirewallPortFilter](https://learn.microsoft.com/en-us/powershell/module/netsecurity/get-netfirewallportfilter?view=windowsserver2025-ps)

### Installation endpoint suggestion

The first-install form offers local SQL address discovery. It suggests the measured
Windows WSL gateway only when its subnet matches a Windows virtual adapter, WSL TCP
reaches the requested port, and exactly one running SQL instance owns a matching
Windows listener. Discovery carries no SQL credentials and never builds or pulls an
image. Missing or ambiguous evidence produces no suggestion. TCP success does not
prove authentication or database access.

Blank/container-loopback input can be filled on a fresh installation after clicking
discovery. An existing pending installation requires choosing the suggestion and
confirming the same SQL instance before Resume changes configuration. Bootstrap
failures also show a measured alternative when the saved address is loopback or a
local Windows adapter; remote SQL endpoints are never silently redirected. The IP
is discovered at runtime, not hardcoded. See [recovery](recovery.md) for backups and
interruption boundaries. Correct temporary SQL credentials must be entered again
for each attempt; they are never persisted in the installation journal or state.

### Automatic local SQL preparation during Install / Resume

The SQL host field stays editable, including for external/cloud/private-network SQL.
Install treats only localhost/127.* (including abbreviated 127.0.01), IPv6 loopback,
and exact addresses found on this Windows machine as local. Other addresses and
hostnames remain unchanged; being in 192.168.* or 10.* alone is not evidence that
an endpoint belongs to the local Windows machine. A saved local instance binding
also permits rediscovery of that same instance after an interrupted first install.

For local targets, after WSL/Docker setup and before SQL bootstrap, main verifies a
unique running SQL instance owns the selected port on the measured Windows gateway.
It measures the WSL private NAT subnet, then automatically requests the existing
narrow firewall operation through UAC. Install is the authorization for this local
preparation; the separate diagnostics Preview/Apply controls remain unchanged.
Non-elevated firewall inventory may be incomplete: the elevated helper rechecks
instance/PID, listener, adapter/subnet and existing rules before adding/enabling the
one exact rule. No SQL credentials enter its request or temporary files. Existing
exact manager/manual rules are reused; unrelated or stale rules are not deleted.
It does not enable TCP, change SQL ports/Mixed Mode, restart SQL or disable firewall.

Main rechecks the measured scope, instance and WSL TCP after elevation. Only then
is the detected endpoint saved in the public draft and reflected in the form. The
worker separately tests TCP from a one-shot application container after its image
build and before passing bootstrap credentials. Failure at either boundary stops
SQL provisioning. Mirrored/unknown networking, ambiguous SQL instances/listeners,
UAC refusal and blocked effective policy require diagnostics; no broad rule or
unverified endpoint fallback is attempted.

The detected gateway is the Windows SQL endpoint reachable from WSL/Docker, not
Docker's bridge/container IP. Gateway addresses are never hardcoded. This behavior
requires native Win10/Win11 acceptance, including firewall idempotence and reboot
network changes; passing mocked tests is not Windows integration verification.
