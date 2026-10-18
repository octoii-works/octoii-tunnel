# AGENTS.md

octoiitunnel lets visitors reach a service on a machine behind NAT through a relay the machine connects out to, and lets
paired visitors talk to the machine end to end encrypted. Start with [README.md](README.md), then the specs:

- [docs/design.md](docs/design.md): the packages, the relay and its hosts, the connector.
- [docs/protocol.md](docs/protocol.md): the relay's HTTP API and the connector connection.
- [docs/security.md](docs/security.md): pairing, the secure channel, and the threat model.
- [docs/development.md](docs/development.md): checks, building and packing.

The specs are the source of truth. When the code needs something they do not say, decide, write it into the spec, and
implement it; when they are wrong, fix the spec in the same commit as the code.

## Background

- octoiitunnel is Octoii's tunnel. Its first user is **OctoiiCode** (`octoii-works/octoii-code`, locally `/Users/devxiyang/code/Tako`),
  an agent that runs as a server on the user's PC. The user talks to it **from their phone**, from anywhere, and the
  phone reaches the PC through octoiitunnel. OctoiiCode depends on `@octoii/tunnel`.
- This repository is the **open core**: the protocol, the relay and the client, all MIT. Octoii's hosted service at
  `octoiitunnel.com` (accounts, named subdomains, billing, quotas, dashboard, direct connections) is closed and lives
  elsewhere. It plugs into the core only through the relay's `authorize` and `meter` hooks. Never put such concerns here.
- The relay is a dumb pipe. It forwards, keeps nothing of the traffic, and knows nothing about secure mode.
- An idle device must cost nothing: the relay never sends on its own, and the `/worker` host hibernates idle sessions.

## Code

- *Clean Code*: clear names, small functions, no flag parameters, errors handled explicitly. Names follow the terms in [docs/design.md](docs/design.md): the device-side process is the **connector**, never "agent".
- KISS and YAGNI. No abstractions before they are needed, no compatibility shims: change the API and migrate the callers.
- Every exported function, class, type and constant has a doc comment that says what it is or does. Comments inside code say why, not what.
- TypeScript: no `any`, no needless type assertions, no non-null assertions (`!`), no constructor parameter properties; validate external input (frames, HTTP, handshake payloads) before narrowing it. `tsconfig.base.json` is strict for every package.
- Constants are `UPPER_CASE`. Each format (a device id, a credential, a header list) is checked by one function, used everywhere.
- A package's root entry is platform-neutral: web standards that Hermes also has. No `TextDecoder`, `btoa` or `atob`: the protocol package has UTF-8 and base64url of its own. Platform code lives in subpaths (`/worker`, `/bun`). Dependencies only point down: protocol ← client, protocol ← relay.
- Bun first, Node compatible. The relay core uses only what its host interfaces give it.
- Cryptography uses audited primitives (the `@noble` libraries); no hand-rolled ciphers, curves or hashes.

## Docs

- Docs describe the design as it is, not its history or progress: no "previously", "renamed", "v2", "not yet". What is built and what is not goes in the README's status.
- Repo docs, comments and commit messages name no other projects or products.
- Self-hosting docs describe what each adapter needs, without recommending a provider.

## Checks

- `bun run check` (format, lint, typecheck, tests) must pass before every commit.
- Commits use conventional messages (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
- Each package keeps a `CHANGELOG.md` with an `[Unreleased]` section, entries under `### Added`, `### Changed`, `### Fixed`, `### Removed` or `### Breaking Changes`.
- No secrets in the repo; tests generate their credentials and keys.
- Read other repositories, such as OctoiiCode's, for reference only: never change, commit, install or format anything outside this repository.
- The packages are published to npm under `@octoii`, all at one version; previews go under the `next` tag. Publish only when Octoii asks.
