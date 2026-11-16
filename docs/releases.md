# Release preparation and distribution

Web versions (initial target 1.3.0) and manager versions (initial 0.1.0) are independent.
The default configurable CDN is `https://cdn.interweb.bg`. Its R2 bucket is `marketing`;
that bucket name is not part of the public URL.

## Build a web release

```sh
python3 scripts/package-release.py \
  --source ../muonline-web-laravel \
  --ref HEAD --version 1.3.0 --output artifacts/web \
  --cdn https://cdn.interweb.bg
```

The script uses `git archive` to build a clean snapshot, leaving uncommitted Laravel
changes untouched. Pass a reviewed commit SHA/tag with `--ref` for reproducibility.
Docker builds the source project's production image, including `composer install
--no-dev` and Vite compilation. A temporary stopped container exports its filesystem;
the container and temporary image are removed. `--runtime /path/to/export` can package
an already-built runtime and requires composer installed metadata with `dev=false`.
The build uses the source project's Dockerfile/image tags/locks; it is not bit-for-bit
reproducible unless all upstream build inputs are pinned as well.

Outputs:

- `application.zip`: Laravel application, Docker PHP files and compiled public/build.
- `vendor.zip`: production vendor directory, with its top-level vendor/ prefix.
- `manifest.json`: schema, kind, version, compatibility, actual game profile keys,
  absolute artifact URLs, sizes and SHA256 hashes.

No node_modules, .env files, storage, .aws, private keys, tests or Git metadata are
packaged. The production application does not need Node.js. Generated artifacts stay
ignored by Git. Inspect the release before distribution; packaging filters cannot
recognize every possible secret a source repository might contain.

## Sign and pin trust

Checksums detect changed artifact bytes. They are **not signatures**. The exact
manifest bytes are signed with Ed25519 and a detached `manifest.json.sig`:

```sh
# Generate/manage keys in an operator-owned private location, outside this repository.
openssl genpkey -algorithm ED25519 -out /private/muonline-release.private.pem
openssl pkey -in /private/muonline-release.private.pem -pubout -out /private/muonline-release.public.pem
RELEASE_KEY_ID=production-2026 \
RELEASE_SIGNING_KEY_FILE=/private/muonline-release.private.pem \
  node scripts/sign-manifest.js artifacts/web/manifest.json
```

Only the public key belongs in `build/trust.json`:

```json
{"keys":{"production-2026":"-----BEGIN PUBLIC KEY-----\n...operator public key...\n-----END PUBLIC KEY-----\n"}}
```

Run `npm run validate:trust` for review builds, or
`node scripts/validate-trust.js --require-key` before production packaging.
The repository intentionally contains an empty trust store. No production trust key
was supplied. Empty trust refuses all releases; there is no trust-on-first-use or
unsigned bypass. Windows CI can inject the reviewed public JSON via repository
variable `RELEASE_TRUST_JSON`. Keep the same key across releases, or ship a manager
with old and new public keys before rotating the signer. Never accept a new trust key
from the release feed itself. Reformatting the manifest after signing invalidates it.

The verifier checks the detached signature before parsing/trusting artifact metadata,
requires HTTPS, refuses redirects, enforces bounded sizes, hashes streamed downloads,
and repeats hash checks before extraction in WSL. Extraction rejects links, traversal,
protected runtime files and special files. There is no support yet for revocation or
expiry metadata; signed older manifests are rejected for installed web/manager updates
by semantic version ordering. An initial install can select any trusted signed release.

## Publish only when explicitly requested

No tool or CI workflow here uploads objects. Once authorized separately, upload these
four web files to bucket `marketing` under `muonline-web/releases/v1.3.0/`:

```text
https://cdn.interweb.bg/muonline-web/releases/v1.3.0/application.zip
https://cdn.interweb.bg/muonline-web/releases/v1.3.0/vendor.zip
https://cdn.interweb.bg/muonline-web/releases/v1.3.0/manifest.json
https://cdn.interweb.bg/muonline-web/releases/v1.3.0/manifest.json.sig
```

The folder was reported empty and no objects have been assumed uploaded. Publish
artifacts first and manifests last. For ongoing discovery, maintain a signed stable
feed (e.g. `muonline-web/releases/stable`) whose manifest points at immutable versioned
artifact URLs, and set that prefix in the panel. The initial version-specific feed
cannot discover other version folders on its own. Cache manifests/signatures briefly
and immutable artifact URLs for longer; account for CDN consistency during publishing.

## Manager build and updates

`npm ci` then `npm run dist:win` on Windows creates the NSIS installer. The Windows
workflow builds review artifacts and screenshots without pushing or publishing. It
does not yet configure Authenticode signing. Before public production distribution,
configure electron-builder code signing using your certificate/provider and verify
SmartScreen/UAC behavior. Ed25519 release signing and Windows Authenticode serve
different purposes; one does not replace the other.

Create and sign the separate manager manifest:

```sh
node scripts/manager-manifest.js dist/MuOnline-Web-Manager-0.1.0-x64.exe 0.1.0 https://cdn.interweb.bg
# Sign dist/manifest.json with the same authorized signing workflow above.
```

Installer URLs use `muonline-web/manager/v0.1.0/`; copy the signed manifest/signature
to the configured manager feed prefix (`muonline-web/manager/stable` by default).
The panel checks web and manager feeds at launch and every six hours while open.
Check failures are displayed on the Updates page. It never auto-downloads or applies
an update. **Update manager** downloads/verifies and starts NSIS and closes the panel so files can be replaced; reopen the panel
after installation. The detached handoff needs Windows acceptance testing. Services in WSL remain separate.

The web release workflow accepts a Laravel ref/version, exports runtime artifacts,
and signs only if an operator configured `RELEASE_PRIVATE_KEY` and `RELEASE_KEY_ID`.
A private sibling repository needs `LARAVEL_READ_TOKEN`. Without a signer the workflow
produces clearly unsigned preparation artifacts, which the manager refuses to install.
