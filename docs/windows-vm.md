# Windows VM acceptance

Use clean Windows 10 and Windows 11 x64 VMs and a disposable SQL Server/game fixture. WSL2 inside
a VM requires nested virtualization in the outer hypervisor; exposing virtualization
inside .wslconfig alone does not configure the outer VM. Confirm the CPU/hypervisor
supports it before running setup. See [Microsoft's WSL VM FAQ](https://learn.microsoft.com/en-us/windows/wsl/faq#can-i-run-wsl-2-in-a-virtual-machine).

1. Save a clean Windows snapshot. Install the CI-built NSIS package and test EN/BG
   language selection. Launch the panel; GitHub/CDN checking must start automatically.
2. Use Install from First installation; WSL, Ubuntu and Docker preparation is automatic.
   Verify the approximately 15-minute note and elapsed timer. Follow the prominent
   reboot dialog after feature activation and after a full modern WSL installation/
   upgrade. Clicking Resume or reopening Manager before reboot must remain blocked.
   After each requested Windows restart, reopen Manager and Resume with freshly
   entered temporary passwords; no Linux user/password wizard should be required.
   Verify `wsl --list --verbose` shows Ubuntu-24.04 at version 2. A virtualization error
   at this point is a VM host prerequisite failure, not an application SQL failure.
3. Restore a disposable game database. Fill the first-install form and select Install.
   Do not supply a release prefix or version. Confirm the latest stable tag is used,
   administrator login works and the dashboard displays the saved installed version.
   Completion must show a green-check dialog with X/Continue close controls, already
   on Control Panel at the top, with the donate footer visible. First installation
   disappears from normal navigation; Uninstall is a collapsed Control Panel section.
4. Close/reopen the panel: it must start on Control Panel without repeating the
   completion dialog. Then reboot/log in to Windows. Confirm the version persists
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

For the 2 GB WSL limit and external 100–200 client workload, follow
[resource and load testing](performance.md). Apply global WSL limits before the clean
installation, and measure remote SQL separately from the web VM.


## Remaining acceptance order

Run the new onboarding/reboot flow on a clean Windows 10 VM snapshot, then a Windows
11 VM. Repeat on separate clean physical Windows 10 and Windows 11 installations
before Domain + SSL acceptance. Record exact installer/source build, Windows build,
WSL version, each reboot checkpoint and resulting support log. The filename/version
may stay the same between test builds, so ensure the transferred installer is fresh.

For Domain + SSL, test the real configured domain, public DNS and port forwarding/
firewall path through Windows/WSL to nginx, issuance, HTTP-to-HTTPS redirect, admin
login/cookies, restart persistence and renewal. A failed issuance must retain the
recoverable installation state. Do not infer real certificate/Windows success from
Linux UI or mocked command tests. Use disposable SQL databases/backups throughout.
