# Windows VM acceptance

Use a clean Windows 11 x64 VM and a disposable SQL Server/game fixture. WSL2 inside
a VM requires nested virtualization in the outer hypervisor; exposing virtualization
inside .wslconfig alone does not configure the outer VM. Confirm the CPU/hypervisor
supports it before running setup. See [Microsoft's WSL VM FAQ](https://learn.microsoft.com/en-us/windows/wsl/faq#can-i-run-wsl-2-in-a-virtual-machine).

1. Save a clean Windows snapshot. Install the CI-built NSIS package and test EN/BG
   language selection. Launch the panel; GitHub/CDN checking must start automatically.
2. Run WSL setup, restart if requested, initialize Ubuntu, then install Docker.
   Verify `wsl --list --verbose` shows Ubuntu-24.04 at version 2. A virtualization error
   at this point is a VM host prerequisite failure, not an application SQL failure.
3. Restore a disposable game database. Fill the first-install form and select Install.
   Do not supply a release prefix or version. Confirm the latest stable tag is used,
   administrator login works and the dashboard displays the saved installed version.
4. Close/reopen the panel, then reboot/log in to Windows. Confirm the version persists
   and services continue independently of the panel. Test Local/IP access from Windows
   and the intended LAN path separately; the outer VM and WSL both affect networking.
5. Save a baseline snapshot and separate SQL backups. A VM snapshot does not capture
   an external SQL Server. Use a later actual signed test release to verify automatic
   discovery, visible notification, explicit Update, data preservation and persisted
   new version after restart. Do not fake installed versions or overwrite release
   artifacts merely to make an upgrade test appear successful.
6. Verify a newer tag with unavailable release files is reported as pending and cannot
   be installed, an equal/older version has no Update action, and failed migrations
   require recovery without advancing the installed version.
7. Test real DNS/TLS/certificate renewal only after localhost/SQL/update checks pass.
   Inspect firewall/NAT for both the outer VM and WSL. Use test databases throughout.

This repository does not provision a hypervisor or claim that these manual Windows
checks have passed. Existing Linux contract/UI tests are separate evidence.
