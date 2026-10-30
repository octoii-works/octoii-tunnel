# Code style

New code reads like the code around it: read two or three files of the package first and match them. The lint holds
what a rule can check (`bun run lint`, with the repository's own rules in `oxlint-plugin-tunnel`); this page holds the
few things it cannot. It is a guide, not a checklist.

## Names

- Plain English words; units in the name (`timeoutMs`, `maxBytes`).
- A function that returns something is named for what it returns (`reconnectDelay`, not `getReconnectDelay`); one that
  acts is a verb (`connect`); a predicate is `isX` or `hasX`.
- The terms are the ones [the client's spec](../packages/tunnel/docs/spec.md#glossary) defines: relay, device, connector, visitor, stream, plain and secure
  mode, pairing.
- An error class is named for what happened; it keeps the error it replaces as `cause`.

## Comments

- Every export has a short `/** … */` comment saying what it is or does, in the present tense.
- Inside a function, comment only why: an invariant, a platform reason, a choice that is not obvious. No history.

## Input and formats

- What comes from outside, frames, HTTP, handshake payloads, is validated before it is narrowed: a decoder checks it and
  gives its type, or refuses it.
- Each format, a device id, a credential, a header list, is checked by one function, used everywhere.

## Platforms

- A package's root entry is platform-neutral: web standards that Hermes also has. It has no `TextDecoder`, `TextEncoder`,
  `btoa` or `atob` (the protocol has UTF-8 and base64url of its own) and no `URL`, which the portability scan holds it to.
- The client reads no clock, timer or randomness of the host's: it takes them as a `Platform`; the relay core takes its
  clock and randomness from its host. Platform code lives in subpaths (`/web`, `/worker`, `/bun`).
- Dependencies only point down: the protocol ← the client, the protocol ← the relay, and the relay's tests on the client.
- Bun first, Node compatible.

## Cryptography

- Audited primitives only, the `@noble` libraries: no cipher, curve or hash of our own.
- Keys and codes come from the platform's secure randomness, never from `Math.random`.

## Docs

- Docs describe the design as it is, not its history or progress: no "previously", "renamed", "v2" or "not yet". What is
  built and what is not goes in the README's status.
- Docs, comments and commit messages name no other projects or products.
- Self-hosting docs say what each host needs, without recommending a provider.
- The open core holds nothing of a hosted service: accounts, billing, quotas and dashboards plug in through the relay's
  hooks, from elsewhere.

## Tests and commits

- A test's name is a sentence about the behaviour it checks. Tests generate their credentials and keys.
- Commits use conventional messages (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`), in plain English.
