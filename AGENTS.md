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
- Bun first, Node compatible. Both client and relay cores are independent of the host runtime. Relay hosts supply server APIs, device storage, scheduling and device routing. Do not add database implementations, SQL or cloud-provider SDKs to this repository.
- The included relay network adapter runs in a single Bun process and takes an injected `DeviceStore`. The bundled memory store is for development and tests. Other runtime adapters and multi-process self-hosting are outside the initial implementation.
- Use small, explicit host interfaces and the `authorize` and `meter` hooks; no plugin framework. Device credential validation, protocol validation and resource limits remain core responsibilities.
- Cryptography uses audited primitives (the `@noble` libraries); no hand-rolled ciphers, curves or hashes.
- Keep the core small: what a hosted service needs goes through `authorize` and `meter`.

## Docs

- Docs describe the design as it is, not its history: no "previously", "renamed" or "v2".
- Repo docs, comments and commit messages name no other projects or products.
- Self-hosting docs describe required capabilities and available adapters, without prescribing a hosting provider. A relay host must support long-lived connections, streaming and routing each device to its session owner.

## Checks

- `bun run check` (format, lint, typecheck, tests) must pass before every commit.
- Commits use conventional messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Each package keeps a `CHANGELOG.md` with an `[Unreleased]` section, entries under `### Added`, `### Changed`, `### Fixed`, `### Removed` or `### Breaking Changes`.
- No secrets in the repo; tests generate their credentials and keys.
- Read other repositories, such as Tako's, for reference only: never change, commit, install or format anything outside this repository.
- Licenses: the repository and both packages are MIT (`LICENSE`). Each package declares `"license": "MIT"`, and packing includes its license file. Packages stay `"private": true` until Klein decides to publish them.
