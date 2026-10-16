# takotunnel protocol

Version 1. This document is the wire format between the agent and the relay, and the relay's HTTP API. Visitors in
plain mode speak ordinary HTTP and WebSocket to the device's address; the secure channel inside a stream is in
[security.md](security.md).

Numbers are big-endian. Text is UTF-8. JSON payloads are objects; a receiver refuses a payload that is not valid JSON
or lacks a required field.

## Relay HTTP API

All on the base domain, over HTTPS.

| Request | Auth | Result |
| --- | --- | --- |
| `POST /v1/devices` with `{ "name"?: string }` | `Authorization: Bearer <registration token>`, decided by `authorize` | `201 { "deviceId", "credential", "address" }` |
| `DELETE /v1/devices/<device id>` | `Authorization: Bearer <credential>` | `204`; the agent connection closes with 4001 |
| `GET /v1/agent/<device id>` with `Upgrade: websocket` | the credential, in the `hello` frame | the agent connection |

- A device id is 26 characters of lowercase base32 (130 random bits, truncated to fit), so it is a DNS label.
- A credential is 32 random bytes in base64url. The relay stores its SHA-256 and compares in constant time.
- The address is `https://<device id>.<base domain>`.
- Errors are JSON `{ "error": { "code", "message" } }` with the matching status: `400 invalid`, `401 unauthorized`,
  `403 forbidden`, `404 not_found`, `429 quota`.

## Agent connection

A WebSocket from the agent to `/v1/agent/<device id>`, carrying binary messages, each one frame. Browsers cannot set
headers on a WebSocket, so the agent authenticates in its first frame rather than on the upgrade.

1. The agent sends `hello` within 10 seconds of the upgrade, or the relay closes with 4003.
2. The relay checks the credential through `authorize`. A wrong one closes with 4001; a version it does not speak, 4002.
3. The relay answers `welcome` with its limits. Streams start.

A newer agent connection for the same device replaces the older one, which the relay closes with 4000.

### Frame

| Bytes | Field |
| --- | --- |
| 1 | version, `1` |
| 1 | type |
| 4 | stream id, `0` for frames about the connection |
| 4 | payload length |
| n | payload |

The relay chooses stream ids, which start at 1 and increase, and opens every stream. A frame for a stream that does
not exist is ignored after a `reset`; a malformed frame closes the connection with 4004.

### Frame types

| Type | Name | Direction | Stream | Payload |
| --- | --- | --- | --- | --- |
| `0x01` | `hello` | agent → relay | 0 | JSON `{ "version": 1, "credential", "agent": "<name>/<version>" }` |
| `0x02` | `welcome` | relay → agent | 0 | JSON `{ "maxStreams", "maxFrame", "initialWindow", "pingInterval", "streamIdle" }` |
| `0x10` | `open` | relay → agent | id | JSON `{ "kind": "http" \| "websocket", "method", "path", "headers": [[name, value]], "remote": { "address", "country"? } }` |
| `0x11` | `head` | agent → relay | id | JSON: for `http`, `{ "status", "headers": [[name, value]] }`; for `websocket`, `{ "accept": true, "protocol"? }` or `{ "accept": false, "status" }` |
| `0x12` | `data` | both | id | body bytes of an `http` stream |
| `0x13` | `message` | both | id | 1 byte, `0` text or `1` binary, then the message of a `websocket` stream |
| `0x14` | `end` | both | id | empty: the sender finished sending (for `websocket`, a close, with JSON `{ "code", "reason" }`) |
| `0x15` | `reset` | both | id | JSON `{ "code", "reason" }`: the stream failed or was cancelled |
| `0x16` | `window` | both | id | 4 bytes: more bytes of credit the receiver grants |
| `0x20` | `ping` | both | 0 | 8 bytes, echoed in `pong` |
| `0x21` | `pong` | both | 0 | the 8 bytes of the `ping` |

`path` includes the query string. `headers` keep their order and repeats.

### Flow control

- Each side may send `data` and `message` payload bytes on a stream only within the credit the other side granted:
  `initialWindow` at `open`, plus every `window` since. The receiver grants more as it consumes.
- Frames about the connection and `head`, `end`, `reset` and `window` need no credit.
- No frame carries more than `maxFrame` payload bytes; a larger body or message is split across frames, and a
  `message` is reassembled by the receiver from consecutive frames whose first byte marks it (`2` continues a text
  message, `3` continues a binary one, and the last frame uses `0` or `1`).

### Liveness and limits

- Both sides send `ping` every `pingInterval`; a side that hears nothing for three intervals closes the connection.
- A stream with no frame for `streamIdle` is reset with `idle`.
- More than `maxStreams` open streams: the relay answers the visitor 503 instead of opening another.
- Defaults the relay announces: `maxStreams` 100, `maxFrame` 65536, `initialWindow` 262144, `pingInterval` 20 s,
  `streamIdle` 300 s.

### Headers

The relay does not forward hop-by-hop headers (`connection`, `keep-alive`, `proxy-*`, `te`, `trailer`,
`transfer-encoding`, `upgrade`, and those `connection` names) or the WebSocket handshake headers. It adds
`x-forwarded-for`, `x-forwarded-proto` and `x-forwarded-host` to `open`.

### Close codes of the agent connection

| Code | Meaning | The agent |
| --- | --- | --- |
| 1000 | closed normally | stops |
| 1012 | the relay restarts or moves the device's object | reconnects |
| 4000 | replaced by a newer connection for the device | stops |
| 4001 | the credential is wrong or the device was removed | stops, and reports it |
| 4002 | unsupported version | stops, and reports what the relay speaks |
| 4003 | no `hello` in time | reconnects |
| 4004 | a malformed frame | reconnects, and reports it |

Any other close or a dropped connection: reconnect with exponential backoff from 1 s to 60 s, with full jitter,
reset after a connection that lasted a minute.

### Reset codes

`cancelled` (the visitor went away), `idle`, `refused` (the handler refused the stream), `too_large`, `protocol` (a
malformed or out-of-credit frame), `internal`.
