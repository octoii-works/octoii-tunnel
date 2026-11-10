//! The bytes of an HTTP/3 stream both ways, as a WebSocket's extended CONNECT hands them over: one end of a duplex pipe,
//! whose other end two tasks carry to and from the stream — what is written sent as it comes, the stream finished as
//! the writer shuts its side, what comes read in order — the pipe's bound holding a side that runs ahead back.

use bytes::{Buf, Bytes};
use h3::error::StreamError;
use h3::quic::{RecvStream, SendStream};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

/// The bytes of a stream both ways.
pub type Stream = DuplexStream;

/// How much of what is written or what came the pipe holds, past which its side waits.
const PIPE_BYTES: usize = 64 * 1024;

/// The sending half of a request stream, as either side holds it.
pub(crate) trait Sending: Send + 'static {
    fn send(&mut self, bytes: Bytes) -> impl Future<Output = Result<(), StreamError>> + Send;
    fn finish(&mut self) -> impl Future<Output = Result<(), StreamError>> + Send;
}

/// The receiving half of a request stream, as either side holds it.
pub(crate) trait Receiving: Send + 'static {
    fn receive(&mut self) -> impl Future<Output = Result<Option<Bytes>, StreamError>> + Send;
}

impl<S: SendStream<Bytes> + Send + 'static> Sending for h3::server::RequestStream<S, Bytes> {
    fn send(&mut self, bytes: Bytes) -> impl Future<Output = Result<(), StreamError>> + Send {
        self.send_data(bytes)
    }

    fn finish(&mut self) -> impl Future<Output = Result<(), StreamError>> + Send {
        h3::server::RequestStream::finish(self)
    }
}

impl<S: RecvStream + Send + 'static> Receiving for h3::server::RequestStream<S, Bytes> {
    async fn receive(&mut self) -> Result<Option<Bytes>, StreamError> {
        Ok(self.recv_data().await?.map(|mut data| data.copy_to_bytes(data.remaining())))
    }
}

impl<S: SendStream<Bytes> + Send + 'static> Sending for h3::client::RequestStream<S, Bytes> {
    fn send(&mut self, bytes: Bytes) -> impl Future<Output = Result<(), StreamError>> + Send {
        self.send_data(bytes)
    }

    fn finish(&mut self) -> impl Future<Output = Result<(), StreamError>> + Send {
        h3::client::RequestStream::finish(self)
    }
}

impl<S: RecvStream + Send + 'static> Receiving for h3::client::RequestStream<S, Bytes> {
    async fn receive(&mut self) -> Result<Option<Bytes>, StreamError> {
        Ok(self.recv_data().await?.map(|mut data| data.copy_to_bytes(data.remaining())))
    }
}

/// The stream whose halves are `send` and `receive`, as one end of a pipe carried to and from it.
pub(crate) fn carried(mut send: impl Sending, mut receive: impl Receiving) -> Stream {
    let (ours, theirs) = tokio::io::duplex(PIPE_BYTES);
    let (mut reading, mut writing) = tokio::io::split(ours);
    n0_future::task::spawn(async move {
        let mut buffer = vec![0; PIPE_BYTES];
        loop {
            match reading.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if send.send(Bytes::copy_from_slice(&buffer[..read])).await.is_err() {
                        return;
                    }
                }
            }
        }
        let _ = send.finish().await;
    });
    n0_future::task::spawn(async move {
        while let Ok(Some(bytes)) = receive.receive().await {
            if writing.write_all(&bytes).await.is_err() {
                return;
            }
        }
        let _ = writing.shutdown().await;
    });
    theirs
}
