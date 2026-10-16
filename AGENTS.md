# AGENTS.md

takotunnel lets visitors reach a service behind NAT through a relay the service's machine connects out to. The relay
only forwards bytes. The design is in [docs/design.md](docs/design.md); the wire format goes in
[docs/protocol.md](docs/protocol.md).

## Code

- *Clean Code*: clear names, small functions, no flag parameters, errors handled explicitly.
- KISS and YAGNI. No abstractions before they are needed, no compatibility shims: change the API and migrate the callers.
- TypeScript: no `any`, no needless type assertions; validate external input before narrowing it. `tsconfig.base.json` is strict for every package.
- A package's root entry is platform-neutral (web standards only); platform code lives in subpaths such as `/bun`. Dependencies only point down.
- Bun first, Node compatible. The relay uses the standard Workers and Durable Object APIs only.
- Keep the core small: anything a hosted service needs goes through the `authorize` and `meter` hooks, not into the core.

## Docs

- Docs describe the design as it is, not its history: no "previously", "renamed" or "v2".
- Repo docs, comments and commit messages name no other projects or products.
- Self-hosting docs do not prescribe a platform: the relay needs the standard Workers and Durable Object APIs, and users choose where to run it.

## Checks

- `bun run check` must pass before every commit.
- Commits use conventional messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Each package keeps a `CHANGELOG.md` with an `[Unreleased]` section, entries under `### Added`, `### Changed`, `### Fixed`, `### Removed` or `### Breaking Changes`.
