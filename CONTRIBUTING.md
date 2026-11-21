# Contributing

Open pull requests against `develop` from a feature branch or your own fork.
`main` is the release branch; promotion from `develop` is managed by the owner.

Both `main` and `develop` are protected. Only **@iwebbg** can update or merge
into these branches. Pull requests require the owner's code review, resolved
review threads, and a passing Windows CI check. New changes dismiss prior
approvals. The owner can explicitly bypass these rules, including for their
own pull requests, which GitHub does not allow them to approve themselves.
Other contributors may review and comment, but their approvals do not replace
the required code owner review.

For development instructions, see [README](README.md#development) and
[AGENTS.md](AGENTS.md). Run `npm test` for backend/release changes and
`npm run test:ui` for panel/preload changes. Never include credentials,
private signing keys, build artifacts, `vendor`, or `node_modules` in a PR.
