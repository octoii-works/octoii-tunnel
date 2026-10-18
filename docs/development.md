# Development and packaging

Use the runtime version in `package.json`. Run `bun install`, then `bun run check` for formatting, lint, strict
platform-neutral and host type checks, and protocol and local HTTP integration tests. Integration tests bind loopback
ports and generate fresh credentials.

## Repository layout

- `packages/protocol/src`: the wire format, shared by the client and the relay.
- `packages/client/src`: the portable client; `bun/` holds the local-port handler, the file pairing store and the command.
- `packages/relay/src`: the router, the device session and the host interfaces; `worker/` and `bun/` are the two hosts.
- `packages/*/test`: unit tests, and one behavioral suite run against both relay hosts.
- `scripts`: workspace builds, packaging, package verification and the development relay.
- `docs`: the design, protocol and security specs.

Dependencies point from the client and the relay to the protocol, and from each host to the relay core. A host owns its
storage, credentials and deployment configuration.

## Build and pack

`bun run build` compiles JavaScript and declarations into each package's `dist/`, building the client before the relay.
Workspace manifests resolve source entries during development. `bun run pack` generates distribution manifests in a
temporary staging directory, points exports at JavaScript and declaration files, resolves workspace dependencies to
exact package versions, and writes tarballs to `dist/packages/`. It includes only runtime code, types, README,
CHANGELOG, LICENSE and package metadata. Tests, source TypeScript and development configuration are excluded.

All three packages share one version and the MIT license. They are separate because an application that embeds the
client needs no relay, and the relay needs no client; host code stays behind explicit subpaths.

`bun run verify:packages` packs and installs the tarballs into an isolated temporary consumer. It checks the file
allowlist and license, imports the roots with both supported desktop runtimes, imports the server subpath with its
runtime, and checks public declarations with and without host types. It may download dependencies. The consumer and
pack staging directories are removed when the command ends.

## Release preparation

1. Update all package versions together and record changes in each package's `[Unreleased]` section.
2. Run `bun run check`, `bun run pack` and `bun run verify:packages`.
3. Inspect the generated tarballs, then publish each with `npm publish <tarball> --access public`, adding `--tag next`
   for a preview. Publication is Octoii's explicit decision; no script uploads packages or deploys a relay.

## Development server

Set `REGISTRATION_TOKEN` and run `bun run relay`. Defaults are `HOST=127.0.0.1`, `PORT=8787` and a local relay origin.
Set `RELAY_ORIGIN` to the public origin when providing ingress, and `DATABASE` to a SQLite file to keep registrations
across restarts.
