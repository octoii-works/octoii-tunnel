# Development and packaging

Use the runtime version in `package.json`. Run `bun install`, then `bun run check` for formatting, lint, strict
platform-neutral and host type checks, and protocol and local HTTP integration tests. Integration tests bind loopback
ports and generate fresh credentials.

## Repository layout

- `packages/client/src`: the portable client; `protocol/` contains shared frames, validation and flow control.
- `packages/relay/src`: routing, sessions and host interfaces; `bun/` contains only server-runtime integration.
- `packages/*/test`: protocol, lifecycle and network behavior checks.
- `scripts`: workspace builds, packaging, package verification and the development relay.
- `docs`: the design, protocol and security contracts.

Dependencies point from runtime adapters to the core, and from relay to the client's shared protocol. Storage is
injected through `DeviceStore`; the repository supplies no database or cloud provider integration. A host owns its
storage lifetime, credentials and deployment configuration.

## Build and pack

`bun run build` compiles JavaScript and declarations into each package's `dist/`, building the client before the relay.
Workspace manifests resolve source entries during development. `bun run pack` generates distribution manifests in a
temporary staging directory, points exports at JavaScript and declaration files, resolves workspace dependencies to
exact package versions, and writes tarballs to `dist/packages/`. It includes only runtime code, types, README,
CHANGELOG, LICENSE and package metadata. Tests, source TypeScript and development configuration are excluded.

Both packages use the same version and MIT license. They remain separate because applications that embed a client
need no relay implementation, and runtime-specific server APIs stay behind explicit subpaths. Runtime adapters do not
become independent packages until their dependencies or release schedules warrant it.

`bun run verify:packages` packs and installs the tarballs into an isolated temporary consumer. It checks the file
allowlist and license, imports the roots with both supported desktop runtimes, imports the server subpath with its
runtime, and checks public declarations with and without host types. It may download dependencies. The consumer and
pack staging directories are removed when the command ends.

## Release preparation

1. Update both package versions together and record changes in each package's `[Unreleased]` section.
2. Run `bun run check`, `bun run pack` and `bun run verify:packages`.
3. Inspect the generated tarballs. Publication is a separate explicit decision: manifests remain `private: true`,
   and no script uploads packages or deploys a relay.

## Development server

Set `REGISTRATION_TOKEN` and run `bun run relay`. Defaults are `HOST=127.0.0.1`, `PORT=8787` and a local relay origin.
Set `RELAY_ORIGIN` to the public origin when providing ingress. The development server uses memory storage and
announces that registrations expire with the process; use an application-owned `DeviceStore` for persistence.
