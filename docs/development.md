# Development and packaging

Use the runtime version in `package.json`. Run `bun install`, then `bun run check`: formatting (`bun fmt`), lint
(oxlint with type information, and the repository's own rules in `oxlint-plugin-tunnel`), unused code (knip), the strict
platform-neutral and host type checks (`bun check`), and the tests, per package on Bun and again on Node (vitest, with
`vitest.bun-test.ts` standing in for `bun:test`): the protocol's and the client's unit tests, the portability scan, the
lint rules' own tests, and the integration tests of the client against both relay hosts. Integration tests bind
loopback ports and generate fresh credentials. `bun run check` passes before every commit.

The portability scan (`packages/tunnel/test/portability.test.ts`) reads every source file of the client and the
protocol but `web.ts`, and fails on a platform module, a package other than the `@noble` libraries, a construct Hermes
refuses or a built-in it lacks, a `URL`, or a read of the host's clock, timers or randomness. It also holds the
protocol to importing nothing of the client. Running the tests on Hermes itself needs a Hermes VM built from source;
it is not part of `bun run check`.

## Repository layout

- `packages/tunnel/src`: the portable client; `protocol/` is the wire format, shared with the relay; `web.ts` is the web
  standards' platform; `bun/` holds the local-port handler, the file pairing store and the command.
- `packages/relay/src`: the router, the device session and the host interfaces; `worker/` and `bun/` are the two hosts.
- `packages/*/test`: unit tests, and one behavioral suite run against both relay hosts.
- `oxlint-plugin-tunnel`: the repository's own lint rules, each with its tests.
- `scripts`: workspace builds, packaging, package verification and the development relay.
- `docs`: the design, protocol and security specs.

Dependencies point from the client and the relay to the protocol, from each host to the relay core, and from the
relay's tests to the client. A host owns its
storage, credentials and deployment configuration.

## Build and pack

`bun run build` compiles JavaScript and declarations into each package's `dist/`, building `@octoii-works/tunnel` before the relay.
Workspace manifests resolve source entries during development. `bun run pack` generates distribution manifests in a
temporary staging directory, points exports at JavaScript and declaration files, resolves workspace dependencies to
exact package versions, and writes tarballs to `dist/packages/`. It includes only runtime code, types, README,
CHANGELOG, LICENSE and package metadata. Tests, source TypeScript and development configuration are excluded.

Both packages share one version and the MIT license, and the relay depends on that exact version of
`@octoii-works/tunnel`. They are separate because an application that embeds the client needs no relay; the relay
imports only the protocol subpath, and host code stays behind explicit subpaths.

`bun run verify:packages` packs and installs the tarballs into an isolated temporary consumer. It checks the file
allowlist and license, imports the roots with both supported desktop runtimes, imports the server subpath with its
runtime, and checks public declarations with and without host types. It may download dependencies. The consumer and
pack staging directories are removed when the command ends.

## Changelogs

Each package keeps a `CHANGELOG.md` with an `[Unreleased]` section, its entries under `### Added`, `### Changed`,
`### Fixed`, `### Removed` or `### Breaking Changes`.

## Release preparation

1. Record changes in each package's `[Unreleased]` section; `bun scripts/version.ts <version>` sets the one version on
   both packages.
2. Run `bun run check`, `bun run pack` and `bun run verify:packages`.
3. The Publish workflow, run by hand on `main` with a version and a dist-tag (`next` for previews), does the same in
   one run: it sets the version, checks, packs, publishes `@octoii-works/tunnel` and then `@octoii-works/tunnel-relay`,
   which depends on that same version, and pushes the release commit and tag. The packages are published under
   `@octoii-works`, previews under the `next` tag, when Octoii asks; no other script uploads packages or deploys a
   relay.

## Development server

Set `REGISTRATION_TOKEN` and run `bun run relay`. Defaults are `HOST=127.0.0.1`, `PORT=8787` and a local relay origin.
Set `RELAY_ORIGIN` to the public origin when providing ingress, and `DATABASE` to a SQLite file to keep registrations
across restarts.
