# Web administrators and Game Masters

The **Web administrators** page supports EN/BG and lists name, email, role and active
status using the installed application's `admin:list`. It includes Game Masters.
Create administrator continues to use the existing private-stdin `admin:create`.

Each table row offers Edit, Reset password and Activate/Deactivate. Edit sends only
changed name/email fields. Reset requires matching password confirmation and a password
with at least 12 characters, upper/lowercase letters, number and symbol. Password fields
are cleared after success **and failure**, and never stored in manager preferences.
Deactivation displays the target identity and requires a separate confirmation click;
activation is an explicit action. Every successful change reloads the authoritative list.

The UI disables deactivation for the last observed active full administrator. Laravel's
transactional protection remains authoritative when a list is stale or another operator
changes an account. Game Masters do not count as full administrators for that rule.
Role assignment and game-account changes are not exposed by this integration.

## Fixed CLI transport

The worker executes argument arrays through the manager-owned Compose project's app
container, using `exec -T app php artisan` and `--json --no-interaction`:

| Runtime action | Artisan command |
| --- | --- |
| adminList | admin:list |
| adminUpdate | admin:update ID, with only supplied --name=, --email=, --active=1/0 or --password-stdin |
| adminDelete | admin:delete ID --force, requiring confirmed=true |

Names and emails remain literal argv entries; passwords never enter argv, environment,
logs or temporary files. A password is sent through private stdin followed by exactly
one newline. The worker validates IDs/options and returns only the documented identity
fields; password hashes and remember tokens are discarded even if unexpectedly present.

The UI favors deactivation and has no permanent-delete button. The narrow confirmed
runtime deletion operation handles both successful deletion and Laravel's refusal for
history-linked identities; the latter recommends deactivation. The manager does not
bypass foreign keys or the last-active-administrator protection.

Exit 1 JSON field errors are preserved as bounded, allow-listed fields and displayed
as text, with known messages translated and supplied/runtime secrets redacted. Raw
stdout/stderr and exception output never reach the panel. Missing commands in an older
release show a web-update instruction. Non-JSON boot failures, timeouts and invalid
schemas show a safe status/retest message. A failed/unknown response never triggers
an automatic mutation retry: refresh the list to inspect the actual result first.

## Release requirement and verification

The manager alone cannot add commands to an existing site. Install/update a **new signed
web runtime containing the current Laravel commands and migrations** before using these
actions. Updating the manager or editing local Laravel source does not update an already
installed web release. No web release was uploaded as part of this integration.

Local checks:

- `npm test`: 36 Node + 31 Python tests, including literal arguments, private stdin,
  allow-listed snapshots, exit-1 refusals, history guidance, stale/old/non-JSON output,
  password redaction, invalid IDs, missing changes and confirmation requirements.
- `npm run test:ui`: all eight pages in EN/BG, table roles/status, editing, validation
  refusal, explicit deactivation confirmation, activation, successful list reloads,
  password clearing after success/failure, last-active UI protection, old-release message
  and the persistent three-link donate footer. IPC is stubbed in this UI harness.
- Actual Laravel `AdministratorManagementCommandTest.php` ran using
  `./docker/compose test tests/Feature/AdministratorManagementCommandTest.php` in the
  disposable network-isolated PHP 8.5/SQLite test container: 19 tests, 84 assertions.
  It covers the real commands and transactional/audit protections, including Game Masters,
  duplicate emails, password rotation, last active administrator and referenced history.
- Linux directory packaging includes the new UI module and updated worker. Actual
  Windows → WSL → installed production app execution remains a Windows VM acceptance
  check after the web release containing these commands is installed.

No sibling Laravel source or legacy adapter was modified by this manager change.
