# @klein-works/takotunnel-protocol

The takotunnel wire format, shared by the client and the relay: frames and their payloads, the rules of the connector
connection (heartbeats, close and reset codes), limits, flow control, WebSocket message chunking, the relay's HTTP API,
and the formats of device ids, credentials and addresses. It does no I/O, and runs wherever web standards do, Hermes
included: UTF-8 and base64url are written out, so it needs no `TextDecoder` or `btoa`.

The format itself is specified in [docs/protocol.md](../../docs/protocol.md).
