# octoiitunnel security

What a relay operator, a network attacker and a stranger can and cannot do, and how pairing and the secure channel
work.

## Parties and what they see

| Party | Plain mode | Secure mode |
| --- | --- | --- |
| The relay operator | Every request and message it forwards, as a reverse proxy does. It keeps none of it | Who connects to which device, when, and how many bytes. Not the content |
| The network between a party and the relay | Nothing beyond TLS metadata | The same |
| A stranger who knows the device's address | Whatever the service serves without authentication | Nothing: the connector refuses a key it has not paired with |
| A visitor the connector has paired with | | What the service gives that visitor |

The relay never stores traffic. What it may record is what `meter` receives: device, stream kind, bytes each way and
duration.

## Keys

- The connector has a static x25519 key pair, made when it first needs one and kept in its pairing store. Its public key
  is the device's identity in secure mode.
- Each visitor has its own static x25519 key pair, kept in its pairing store (on a phone, the app's storage or the
  browser's IndexedDB, with the private key non-extractable where the platform allows).
- The connector's pairing store holds the visitors it has paired with: each one's public key, a name, and when it paired
  and was last seen. Removing a visitor revokes it at once: its next handshake fails, and its open channels close.

## Pairing

1. **Offer.** The connector makes a pairing code (16 random bytes), valid for 5 minutes and for one use, and shows the
   offer as a URL, usually as a QR code:

   ```text
   https://<device id>.<base domain>/#octoiitunnel-pair=<code, base64url>&key=<connector public key, base64url>
   ```

   The fragment never leaves the visitor's device: a browser sends no fragment, and the visitor library reads the
   offer itself. The relay never learns the code or the key from it.
2. **Handshake.** The visitor opens a WebSocket stream to `/.octoiitunnel/secure` and runs the handshake below, sending
   the code in its last handshake message.
3. **Check.** The connector accepts the visitor's key only if the code is one it offered, unused and unexpired; it then
   spends the code and records the key. The visitor accepts the connector only if the connector's static key in the handshake
   equals the key from the offer.
4. **Done.** Both sides keep the other's key. The service may ask the user on the device to confirm the new visitor,
   and may name it.

A code is checked in constant time. Five failed codes within a minute stop new pairings for that minute.

## Secure channel

A WebSocket stream to `/.octoiitunnel/secure`, carrying binary messages. The relay forwards it like any other stream.
The connector library handles the path itself and never passes it to the service's handler.

### Handshake

`Noise_XX_25519_ChaChaPoly_SHA256` (Noise revision 34), the visitor the initiator, prologue `octoiitunnel/1`. Each
handshake message is one WebSocket message.

| Message | Direction | Noise tokens | Payload |
| --- | --- | --- | --- |
| 1 | visitor → connector | `e` | empty |
| 2 | connector → visitor | `e, ee, s, es` | empty |
| 3 | visitor → connector | `s, se` | JSON `{ "pair"?: <code>, "name"?: string }` |

- With `pair`: the pairing check above.
- Without: the connector accepts only a visitor key it has paired with.
- The visitor checks the connector's static key against the key it paired with (or, when pairing, the key in the offer)
  before it sends message 3, and aborts on a mismatch.
- A refused handshake ends with a WebSocket close, code 4401, and no reason that tells a stranger more.
- An accepted handshake: the connector sends `ready` as the first transport message. The visitor counts the channel
  as open, and a pairing as done, only once `ready` arrives, since the visitor writes the last handshake message and
  cannot otherwise tell whether the connector accepted it.
- A handshake must finish, `ready` included, within 10 seconds.

### Transport

- After the handshake each WebSocket message is one Noise transport message: at most 65535 bytes of ciphertext, so at
  most 65519 bytes of plaintext. A channel frame therefore carries at most 65514 payload bytes; longer messages and
  bodies go in several frames. The nonce is the message's count, so a dropped, reordered or replayed message breaks
  the channel, which the visitor library reopens.
- Each side rekeys (Noise `Rekey`) every 2^20 messages.
- The plaintext of a transport message is a channel frame:

  | Bytes | Field |
  | --- | --- |
  | 1 | type |
  | 4 | id: `0` for messages, a request id for fetches |
  | n | payload |

  | Type | Name | Payload |
  | --- | --- | --- |
  | `0x01` | `message` | 1 byte, `0` text or `1` binary, then the bytes; `2` and `3` continue a text or binary message across frames, the last frame using `0` or `1` |
  | `0x02` | `request` | JSON `{ "method", "path", "headers": [[name, value]] }`, from the visitor |
  | `0x03` | `response` | JSON `{ "status", "headers": [[name, value]] }`, from the connector |
  | `0x04` | `body` | body bytes of the request or response with that id |
  | `0x05` | `end` | empty: the body with that id is complete |
  | `0x06` | `cancel` | empty: the request with that id is abandoned |
  | `0x07` | `close` | JSON `{ "code", "reason" }`: the channel is closing |
  | `0x08` | `ready` | empty: the connector accepted the handshake, sent first and once |

- The service sees a secure channel as a `SecureChannel`: the visitor's paired identity (public key, name), messages
  either way, and fetch-style requests answered by a handler, so it can serve the same app over the channel as it
  serves in plain mode.

## Where the visitor's code comes from

End-to-end encryption protects nothing if the code that runs it was altered on the way. A web page loaded through the
relay in plain mode is code the relay operator could change. So secure mode needs visitor code that does not come
through the relay unprotected:

- an installed app or command, which carries the library;
- or a web app whose shell the visitor loads once from somewhere it trusts (such as the device itself on the local
  network) and keeps, after which it loads everything else over the secure channel.

The library makes no choice here; the service using it does, and its docs say which.

## What the core does not protect against

- A compromised device or visitor: whoever holds a private key is that party.
- Traffic analysis by the relay operator: timing and sizes of encrypted messages.
- A visitor whose code came through the relay unprotected (see above).
- Denial of service by the relay operator, who can always refuse to forward.
