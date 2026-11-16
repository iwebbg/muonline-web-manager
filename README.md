# MuOnline Web Manager

Windows desktop control panel and separate NSIS installer for the existing MuOnline
Web Laravel stack. The backend runs in Ubuntu-24.04 / WSL2 with Docker Engine.
Closing the panel leaves services running; Windows sleep/shutdown stops availability.
The panel supports English and Bulgarian through the language selector in the header.
The choice is saved across restarts; NSIS also offers English/Bulgarian selection.
Help & Support links to the project’s GitHub issue form, email contact and optional
donations. Reports are prepared by the user; credentials/logs are never attached automatically.
Installation automatically selects the latest stable Laravel GitHub tag and its signed
CDN runtime. Updates compare that version with the saved installed version and notify
the user; application changes require an explicit Update button.

The current implementation is **ready for code/UI review, not a verified production
Windows release**. Read [review evidence and remaining checks](docs/review.md).

```sh
npm ci
# If npm withheld dependency scripts: node node_modules/electron/install.js
npm start
npm test
npm run test:ui
```

Node 24+ is needed for development only. `test:ui` needs a graphical session or Xvfb
on Linux. Runtime operations intentionally reject Linux desktop execution.
If your terminal sets `ELECTRON_RUN_AS_NODE`, unset it before `npm start`.

On Windows, `npm run dist:win` builds the assisted NSIS installer. The
[Windows CI workflow](.github/workflows/windows.yml) builds and retains review
artifacts without publishing. It can run after the branch is pushed by an operator.

- [Architecture and security boundaries](docs/architecture.md)
- [Build, sign and distribute releases](docs/releases.md)
- [SQL Troubleshooting: EN/BG diagnostics and Windows VM checks](docs/sql-troubleshooting.md)
- [Recovery and operational limits](docs/recovery.md)
- [Acceptance checklist and local evidence](docs/review.md)
- [Project maintenance skill](skills/muonline-manager/SKILL.md)

Production release signing requires an operator-owned Ed25519 key, its public key
pinned in `build/trust.json`, and actual published artifacts. An empty trust store
blocks deployment; keep the pinned public key matched to the release signing key. No R2 objects are assumed to exist or uploaded by CI.

Support development: [Buy Me a Coffee](https://buymeacoffee.com/interweb.bg) ·
[Ko-fi](https://ko-fi.com/interwebltd) · [PayPal](https://paypal.me/interwebltd).
