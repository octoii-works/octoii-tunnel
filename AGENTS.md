# AGENTS.md

takotunnel lets visitors reach a service on a machine behind NAT through a relay the machine connects out to, and lets
paired visitors talk to the machine end to end encrypted. Start with [README.md](README.md), then the specs:

- [docs/design.md](docs/design.md): the parts and how they fit.
- [docs/protocol.md](docs/protocol.md): the relay's HTTP API and the frames on the agent connection.
- [docs/security.md](docs/security.md): pairing, the secure channel, and the threat model.

The specs are the source of truth. When the code needs something they do not say, decide, write it into the spec, and
implement it; when they are wrong, fix the spec in the same commit as the code.

## Background

- takotunnel is Klein's tunnel. Its first user is **Tako** (`klein-works/tako`, locally `/Users/devxiyang/code/Tako`),
  an agent that runs as a server on the user's PC. The user talks to it **from their phone**, from anywhere, and the
  phone reaches the PC through takotunnel. Tako depends on `@klein-works/takotunnel`: it gives the agent connection a
  handler, offers pairings as QR codes, and serves its protocol over secure channels.
- This repository is the **open core**: the protocol, the relay and the client. Klein's hosted service at
  `takotunnel.dev` (accounts, sign-in, named subdomains, billing, quotas, dashboard) is closed and lives elsewhere. It
  plugs into the core only through the relay's `authorize` and `meter` hooks. Never put such concerns here.
- The relay is a dumb pipe. It forwards, keeps nothing of the traffic, and knows nothing about secure mode: a secure
  channel is an ordinary WebSocket stream to the relay.

## Code

- *Clean Code*: clear names, small functions, no flag parameters, errors handled explicitly.
- KISS and YAGNI. No abstractions before they are needed, no compatibility shims: change the API and migrate the callers.
- TypeScript: no `any`, no needless type assertions; validate external input (frames, HTTP, handshake payloads) before narrowing it. `tsconfig.base.json` is strict for every package.
- A package's root entry is platform-neutral: web standards only (`fetch`, `WebSocket`, streams, `crypto.getRandomValues`), so the client runs in Bun, Node, browsers, workers and Hermes. Platform code lives in subpaths such as `/bun`. Dependencies only point down.
- Bun first, Node compatible. The relay uses the standard Workers and Durable Object APIs only.
- Cryptography uses audited primitives (the `@noble` libraries); no hand-rolled ciphers, curves or hashes.
- Keep the core small: what a hosted service needs goes through `authorize` and `meter`.

## Docs

- Docs describe the design as it is, not its history: no "previously", "renamed" or "v2".
- Repo docs, comments and commit messages name no other projects or products.
- Self-hosting docs do not prescribe a platform: the relay needs the standard Workers and Durable Object APIs, and users choose where to run it.

## Checks

- `bun run check` (format, lint, typecheck, tests) must pass before every commit.
- Commits use conventional messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Each package keeps a `CHANGELOG.md` with an `[Unreleased]` section, entries under `### Added`, `### Changed`, `### Fixed`, `### Removed` or `### Breaking Changes`.
- No secrets in the repo; tests generate their credentials and keys.
- Read other repositories, such as Tako's, for reference only: never change, commit, install or format anything outside this repository.
- Licenses: the repository, and so the relay, is under FSL-1.1-MIT (`LICENSE`); the client package is under MIT (`packages/client/LICENSE`), so the MIT-licensed services that embed it, such as Tako, stay MIT. Each package's `license` field says which, and packing copies its license file in. Packages stay `"private": true` until Klein decides to publish them.
