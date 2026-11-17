# Windows development with a disposable WSL distribution

Run from a Windows terminal in this repository with Node 24+, installed npm
dependencies and a recent WSL supporting named Ubuntu installations. No NSIS
installer is needed. This is a real runtime, not the stubbed UI smoke test.

## First run

```powershell
npm run dev:wsl:setup
```

Setup prepares the fixed Linux account and systemd automatically via root/exec;
no interactive Ubuntu username/password setup is needed. If Windows requests a
reboot, complete it first. The setup command uses
`wsl --install -d Ubuntu-24.04 --name MuOnline-Dev --no-launch`; it never falls
back to installing the ordinary Ubuntu-24.04 identity. Older WSL versions need
an operator-managed WSL update before using this workflow.
Setup explicitly selects WSL2 for MuOnline-Dev without changing the global
default WSL version.
The WSL install/version commands print their exact command and stream WSL's output directly to
the terminal. They receive no credentials. Failures identify the install/version
step and stop immediately; runtime and SQL output remains private. Do not reset
again just to diagnose an installation error: read the WSL message first.
Setup can be rerun after a partial installation: when MuOnline-Dev is already
registered it skips installation, checks WSL2 and prepares the Linux account/systemd. It does
not unregister the distribution or reset its files.

```powershell
npm run dev
```

In the panel, fill in the installation form and click Install. The same coordinator
prepares missing WSL/Linux/Docker/keepalive stages before application setup. You may
also run `npm run dev` directly and let Install create MuOnline-Dev. A persistent DEV
notice and window title identify this runtime. The panel still requires valid signed web releases and the
normal trust configuration; development does not bypass release verification.

The worker enables systemd when necessary and restarts only MuOnline-Dev. It saves
the Linux username and public setup progress in the separate dev userData directory.
To open a shell manually, use `wsl -d MuOnline-Dev -u muonline --exec /bin/bash`.
No Linux password is generated/stored; existing accounts/passwords are preserved.

## Diagnose an installation failure

Dev mode records subprocess start/end, elapsed time, exit code and redacted output
under `/opt/muonline-web/diagnostics/` in MuOnline-Dev. Click Logs in the panel or run:

```powershell
npm run dev:logs
```

This command reads logs without rebuilding or retrying bootstrap. Logging cannot
recover output from an earlier attempt made before logging was enabled: reproduce
with Resume once after restarting the updated dev panel. No WSL reset is needed.
Known passwords and APP_KEY are redacted; operational details can remain, so review
the output before sharing publicly. Both normal and dev panels also save local
per-operation files under Electron userData/logs. Logs opens that Windows folder;
these support files survive runtime uninstall/reset. The WSL copy remains
root-private, bounded/rotated and is removed with a dev WSL reset.

## Repeat from zero

Close the dev panel, then run:

```powershell
npm run dev:wsl:reset
```

Type **MuOnline-Dev** at the prompt. This stops/removes only the
`MuOnline-Web-Dev-WSL` task and unregisters only `MuOnline-Dev`. All files, Docker
images/containers/volumes and local databases in that distribution are permanently
deleted. It does not recursively delete Windows directories or reset the panel's
public preferences. Then repeat First run.

Setup/reset and the dev panel share an exclusive directory lock under
`%APPDATA%\MuOnline-Web-Manager-Dev\runtime.lock`. A crash can leave the empty lock
directory behind: close/check all dev processes before manually removing that
empty directory. The tool does not guess that an existing lock is stale.

## Isolation boundaries

| Resource | Normal launch / installer | `npm run dev` |
| --- | --- | --- |
| WSL distribution | Ubuntu-24.04 | MuOnline-Dev |
| Windows logon task | MuOnline-Web-WSL | MuOnline-Web-Dev-WSL |
| Panel settings and setup progress | Normal Electron userData | `%APPDATA%\MuOnline-Web-Manager-Dev` |
| Runtime files and Docker | Normal distro | Dev distro |
| SQL diagnostics | Normal distro | Dev distro |
| Windows SQL change application | Explicit preview/confirmation | Disabled |
| Manager installer update | Explicit action | Disabled |

Use separate disposable SQL databases/logins and a restored test game schema.
External SQL Server data is neither isolated nor deleted by a WSL reset. Runtime
installation can still modify whichever SQL server you explicitly configure.
Host ports, Windows networking, filesystem mounts and machine resources are shared;
stop conflicting websites before testing port 80/443. This does not test installing
Windows WSL features from scratch, NSIS, reboot behavior, real SSL or production SQL.

`npm start` retains the normal runtime identity. Packaged applications reject the
dev launch flag. No reset operation is exposed over renderer IPC.

Reference for named Ubuntu installations:
https://ubuntu.com/wsl/docs/stable/howto/manage-and-configure/
