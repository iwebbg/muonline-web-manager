# Website settings — Manager 0.2.0

After a completed installation, **Website settings / Настройки на сайта** reads
configuration from the installed site's private `.env`. No WSL console is needed.
This screen is separate from initial installation and the manager's own preferences.

## Available groups

| Group | Settings |
| --- | --- |
| Payments | Default currency; Stripe, PayPal and Revolut enable switches, API/webhook credentials, PayPal/Revolut sandbox/live mode, Revolut API version; manual Revolut.me switch/tag when supported |
| Email / SMTP | `log` or `smtp` delivery, SMTP scheme/host/port/username/password, sender email/name and optional EHLO domain |
| Object storage | AWS/S3-compatible key ID/secret, region, bucket, HTTPS endpoint/public URL and path-style switch |
| reCAPTCHA | v3 enable switch, site/secret keys, minimum score and optional hostname |
| Website and game | Website name and EN/BG defaults; game display name, status host/port/timeout/cache; rankings/events limits, event/content timezones, market duration, activation/password-reset/session lifetimes |

Supported fields are detected from `env()` references in the installed Laravel
release's `config/*.php`. A newer manager does not make a missing web feature
available: unsupported fields are disabled and explain that a newer web release is
needed. The allow-list and bilingual field metadata live in `runtime/worker.py`.

Payments require the provider's complete API and webhook credentials before enabling.
Automated providers require an HTTPS site origin; use **Access and SSL** first.
The screen provides copyable webhook URLs. Register the endpoint with the provider
and paste its signing secret/ID; the manager does not create external endpoints or
contact payment providers. Revolut.me receipts are reviewed in the web admin panel.

SMTP uses the installed Laravel `MAIL_SCHEME` contract, rather than the older
`MAIL_ENCRYPTION` option. An existing `MAIL_URL` takes precedence over individual
SMTP fields, so it must be explicitly cleared when editing those fields. The screen
allows clearing that override, never editing a credential-bearing URL.

S3 credentials can be prepared for a future web release. The manager detects whether
`league/flysystem-aws-s3-v3` is installed and displays a warning when absent. Saving
these settings does **not** enable scheduled backups, migrate uploads, change
`FILESYSTEM_DISK`, or upload anything. The current Laravel reference has an S3 disk
configuration but no S3 package or automatic-backup scheduling contract. Those
features require a separate reviewed implementation and web release.

The screen intentionally excludes database credentials, APP_KEY, APP_DEBUG,
bootstrap credentials, Redis/queue/session drivers, arbitrary mail commands,
payment API endpoint overrides, the reCAPTCHA verification endpoint and filesystem
selection. Access/SSL and game write switches retain their dedicated workflows.
SQL endpoint repair remains in installation recovery. Public site content and
Credits packages remain in web administration.

## Secret handling

Existing secrets never leave WSL. The UI receives only a configured/not-configured
flag, and offers **Keep**, **Replace**, and **Clear**. An unchanged or empty UI field
is never an implicit clear. Replacement inputs are erased after success or failure.
Neither credentials nor settings drafts are saved to desktop preferences/localStorage.

Inputs travel as JSON through a fixed preload/main action and private WSL stdin.
They never become shell source, process arguments or a user-selected runtime action.
Nested replacement values and saved secrets are registered with support-log redaction.
A plain SHA256 revision of the complete private dotenv content provides a stale-form
check, not a release signature or an authentication mechanism.

## Applying and recovery

**Apply settings** uses the existing operation modal, elapsed timer and final status
refresh. The customer sees that settings are being applied and that a short website
interruption is possible. Donation links remain visible.

The worker requires a `ready` installation, explicit confirmation, a current revision,
and a valid allow-listed patch before effects. It then:

1. Saves exact private copies of `.env` and `state.json` beneath
   `/opt/muonline-web/backups/site-settings-<timestamp>-<random>/`.
2. Journals `site-settings-changing` with the recovery path.
3. Stops queue/scheduler consumers, writes only selected dotenv entries atomically,
   and updates the private deployment state's environment.
4. Clears Laravel's config cache in a one-shot PHP container, bypassing bootstrap.
5. Uses Compose `up -d --force-recreate --wait --wait-timeout 300` so services
   reread `env_file` and nginx resolves the current application container.
6. Marks the deployment `ready` only after successful activation.

No migrations, APP_KEY rotation, SQL provisioning or filesystem moves are requested.
The manager's existing `AUTO_MIGRATE=false` runtime configuration remains unchanged.
Unrelated values, comments and multiline entries in `.env` are preserved.

On ordinary activation failure, exact prior dotenv/state bytes are restored and the
old project is recreated. If recovery also fails, the phase becomes
`site-settings-recovery-required`. An interruption leaves `site-settings-changing`.
Both phases block normal Start, update and settings changes. As WSL root, inspect
the recorded private backup, restore both `.env` and `state.json`, restore `.env`
ownership to uid/gid 33, clear Laravel config and recreate the project. A successful
health check is required before considering recovery complete. Never paste private
backup contents into issues. See [recovery](recovery.md).

## Verification boundaries

Python tests use temporary files and mocked Compose calls to cover secret filtering,
capability detection, stale edits, validation, literal dotenv escaping, untouched
multiline values, exact backup/recovery and failure checkpoints. Node tests cover
fixed IPC dispatch and nested-secret log redaction. The Electron smoke test exercises
EN/BG rendering, unsupported fields, preserve/replace choices, modal progress, error
cleanup, successful submission and the permanent footer.

These tests do not establish SMTP delivery, payment webhook verification, S3
connectivity or native Windows container recreation. Validate those on a disposable
Windows installation with sandbox provider accounts before release.
