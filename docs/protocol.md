# takotunnel protocol

Version 1. The wire format between the connector and the relay, and the relay's HTTP API. Visitors in plain mode speak
ordinary HTTP and WebSocket to the device's address; the secure channel inside a stream is in
[security.md](security.md). `@klein-works/takotunnel-protocol` implements this document.

Numbers are big-endian. Text is UTF-8. JSON payloads are objects; a receiver refuses a payload that is not valid JSON,
lacks a required field, or has a field of the wrong type.

## Relay HTTP API

All on the base domain, over HTTPS.

| Request | Auth | Result |
| --- | --- | --- |
| `POST /v1/devices` with `{ "name"?: string }` | `Authorization: Bearer <registration token>`, then `authorize` | `201 { "deviceId", "credential", "address" }` |
| `DELETE /v1/devices/<device id>` | `Authorization: Bearer <credential>` | `204`; the connector connection closes with 4001 |
| `GET /v1/connect/<device id>` with `Upgrade: websocket` | the credential, in the `hello` frame | the connector connection |

- A device id is 26 characters of lowercase base32 (`a`–`z`, `2`–`7`): 130 random bits, and a DNS label.
- A credential is 32 random bytes in base64url without padding: 43 characters. The relay stores its SHA-256 and
  compares in constant time.
- The address is `https://<device id>.<base domain>`.
- A registration body is at most 4096 bytes; a name at most 128 characters.
- Errors are JSON `{ "error": { "code", "message" } }`: `400 invalid`, `401 unauthorized`, `403 forbidden`,
  `404 not_found`, `426 upgrade_required`, `429 quota`, `502 offline`, `503 busy`.

## Connector connection

A WebSocket from the connector to `/v1/connect/<device id>`. Binary messages are frames; text messages are heartbeats.
Browsers cannot set headers on a WebSocket, so the connector authenticates in its first frame.

1. The connector sends `hello` within 10 seconds of the upgrade, or the relay closes with 4003. Nothing else may come
   before `welcome`.
2. The relay checks the credential, then `authorize`. A wrong credential closes with 4001; an unsupported version, 4002.
3. The relay answers `welcome`. Streams start.

A newer connection for the same device replaces the older one only once it has authenticated; the relay closes the
older one with 4000. A connection that fails to authenticate leaves the current one alone.

### Heartbeats

- The connector sends the text message `ping` every `heartbeat` milliseconds; the relay answers the text message
  `pong`. A host may answer without waking the device session, and records when it last answered.
- The relay never sends a heartbeat of its own.
- The connector closes a connection that has answered nothing for three intervals (code 1001) and reconnects.
- A visitor stream that arrives when the connector has sent no heartbeat for three intervals gets 502, and the relay
  closes that connection with 1011.
- Any other text message closes the connection with 4004.

### Frame

| Bytes | Field |
| --- | --- |
| 1 | version, `1` |
| 1 | type |
| 4 | stream id; `0` for `hello` and `welcome` |
| 4 | payload length |
| n | payload |

The relay chooses stream ids, starting at 1 and increasing for the life of the connection, and opens every stream. A
frame for a stream that does not exist is answered with `reset` (unless it is one). A malformed frame, a frame of an
unknown type, or a stream id of `0` on a stream frame closes the connection with 4004.

### Frame types

| Type | Name | Direction | Payload |
| --- | --- | --- | --- |
| `0x01` | `hello` | connector → relay | JSON `{ "version": 1, "credential", "connector": "<name>/<version>" }` |
| `0x02` | `welcome` | relay → connector | JSON `{ "maxStreams", "maxFrame", "initialCredit", "heartbeat", "streamIdle" }` |
| `0x10` | `open` | relay → connector | JSON `{ "kind": "http" \| "websocket", "method", "path", "headers": [[name, value]], "protocols"?: [string], "remote": { "address" } }` |
| `0x11` | `head` | connector → relay | JSON: for `http`, `{ "status", "headers": [[name, value]] }`; for `websocket`, `{ "accept": true, "protocol"? }` or `{ "accept": false, "status" }` |
| `0x12` | `data` | both | body bytes of an `http` stream |
| `0x13` | `message` | both | 1 byte of flags, then message bytes of a `websocket` stream |
| `0x14` | `end` | both | `http`: empty, the sender finished its body. `websocket`: JSON `{ "code", "reason" }`, the sender closed |
| `0x15` | `reset` | both | JSON `{ "code", "reason" }`: the stream failed or was cancelled, both ways |
| `0x16` | `credit` | both | 4 bytes: more bytes the receiver will take on this stream |

- `path` includes the query string and starts with `/`. `headers` is a list of name and value pairs in order; repeats
  such as `set-cookie` stay separate. At most 128 headers.
- `protocols` lists the WebSocket subprotocols the visitor asked for; `protocol` is the one the connector chose.
- `open` and `head` must fit in one frame.

### Messages

The flags byte of a `message` frame: bit 0 is `1` for binary and `0` for text; bit 1 is `1` when more frames of the
same message follow. A message larger than `maxFrame` is split; the receiver reassembles consecutive frames and refuses
a message larger than 16 MiB.

### HTTP streams

Each direction ends on its own: the visitor's body with `end` from the relay, the response body with `end` from the
connector. A connector may answer before reading the whole request body; it then sends `end` for the response and
`reset` with `cancelled`, and the relay keeps the response while it stops the upload. A stream is done when both
directions have ended, or on `reset`. Trailers are not carried.

### WebSocket streams

The relay sends `open` with `kind: "websocket"` and waits for `head` before it accepts the visitor's upgrade (or
answers with the refusal's status). Then `message` frames flow both ways, and either side ends the stream with `end`
carrying the WebSocket close code and reason. A WebSocket stream to `/.takotunnel/secure` is a secure channel, handled
by the connector library itself.

### Flow control

- On each stream, a side may send `data` and `message` payload bytes only within the credit the other side granted:
  `initialCredit` at `open`, plus every `credit` since. The receiver grants more as its consumer takes bytes, never
  beyond `initialCredit` outstanding.
- `open`, `head`, `end`, `reset` and `credit` need no credit.
- No frame carries more than `maxFrame` payload bytes.
- Each side also stops sending while its socket's own send buffer is full.

### Limits

`welcome` announces the limits, in bytes and milliseconds:

| Limit | Default | Range |
| --- | --- | --- |
| `maxStreams` | 100 | 1–1000 |
| `maxFrame` | 65536 | 1024–65536 |
| `initialCredit` | 262144 | `maxFrame`–1048576 |
| `heartbeat` | 25000 | 5000–120000 |
| `streamIdle` | 300000 | 10000–3600000 |

A stream with no frame for `streamIdle` is reset with `idle`. More than `maxStreams` open streams: the relay answers the
visitor 503 with `retry-after` instead of opening another.

### Headers

Neither side forwards hop-by-hop headers (`connection`, `keep-alive`, `proxy-*`, `te`, `trailer`, `transfer-encoding`,
`upgrade`, and those `connection` names), `host`, or the WebSocket handshake headers. The relay drops any
`x-forwarded-*` a visitor sent, and adds `x-forwarded-for`, `x-forwarded-proto` and `x-forwarded-host` from what it
knows.

### Close codes of the connector connection

| Code | Meaning | The connector |
| --- | --- | --- |
| 1000 | closed normally | stops |
| 1001 | the connector gave up on a silent connection | (sent by the connector) reconnects |
| 1011 | the relay saw no heartbeat for three intervals, or failed | reconnects |
| 1012 | the relay restarts or moves the session | reconnects |
| 4000 | replaced by a newer connection for the device | stops |
| 4001 | the credential is wrong or the device was removed | stops, and reports it |
| 4002 | unsupported version | stops, and reports it |
| 4003 | no `hello` in time | reconnects |
| 4004 | a malformed frame or message | reconnects, and reports it |

Any other close or a dropped connection: reconnect with exponential backoff from 1 s to 60 s, with full jitter, back to
1 s after a connection that lasted a minute.

### Reset codes

`cancelled` (the visitor went away, or the connector stopped an upload it no longer reads), `idle`, `refused` (the
handler refused the stream), `too_large`, `protocol` (a malformed or out-of-credit frame), `internal`. A reason is at
most 256 characters.
