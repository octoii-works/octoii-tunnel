# Development and packaging

Use the runtime version in `package.json`. Run `bun install`, then `bun run check` for formatting, lint, strict
platform-neutral and host type checks, the protocol's and the client's unit tests, and the
integration tests of the client against both relay hosts. Integration tests bind loopback ports and generate fresh
credentials.

## Repository layout

- `packages/tunnel/src`: the portable client; `protocol/` is the wire format, shared with the relay; `bun/` holds the local-port handler, the file pairing store and the command.
- `packages/relay/src`: the router, the device session and the host interfaces; `worker/` and `bun/` are the two hosts.
- `packages/*/test`: unit tests, and one behavioral suite run against both relay hosts.
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

## Release preparation

1. Record changes in each package's `[Unreleased]` section; `bun scripts/version.ts <version>` sets the one version on
   both packages.
2. Run `bun run check`, `bun run pack` and `bun run verify:packages`.
3. The Publish workflow, run by hand on `main` with a version and a dist-tag (`next` for previews), does the same in
   one run: it sets the version, checks, packs, publishes `@octoii-works/tunnel` and then `@octoii-works/tunnel-relay`,
   which depends on that same version, and pushes the release commit and tag. Publication is Octoii's explicit
   decision; no other script uploads packages or deploys a relay.

## Development server

Set `REGISTRATION_TOKEN` and run `bun run relay`. Defaults are `HOST=127.0.0.1`, `PORT=8787` and a local relay origin.
Set `RELAY_ORIGIN` to the public origin when providing ingress, and `DATABASE` to a SQLite file to keep registrations
across restarts.
