//! A WebSocket's messages over the stream an extended CONNECT hands over: the stream is already the WebSocket's, its
//! opening done by the CONNECT, so the messages are framed on it at once, as RFC 9220 has it — the same framing on
//! either side.

use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::Role;

use crate::stream::Stream;

/// A WebSocket over the tunnel.
pub type Socket = WebSocketStream<Stream>;

/// The WebSocket of the side that asked for it, over `stream`.
pub async fn client(stream: Stream) -> Socket {
    WebSocketStream::from_raw_socket(stream, Role::Client, None).await
}

/// The WebSocket of the side that answered, over `stream`.
pub async fn server(stream: Stream) -> Socket {
    WebSocketStream::from_raw_socket(stream, Role::Server, None).await
}
