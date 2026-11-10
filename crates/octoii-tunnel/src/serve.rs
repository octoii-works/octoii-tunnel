//! A machine's HTTP service served to every peer that reaches it, over HTTP/3: each session in a task of its own, each
//! request in one of its own, carrying the key of the peer that sent it as its `Remote`; its body read as it comes, the
//! response's sent as the service gives it. A request of extended CONNECT — a WebSocket, as RFC 9220 has it — carries
//! an `OnConnect`, which gives the stream once the service answered it with success, as an upgrade is handed over.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use bytes::{Buf, Bytes};
use h3::error::StreamError;
use http::{Method, Request, Response};
use http_body::Frame;
use http_body_util::BodyExt as _;
use iroh::PublicKey;
use iroh::endpoint::Incoming;
use tokio::sync::{mpsc, oneshot};
use tower_service::Service;

use crate::stream::{Receiving, Sending, Stream, carried};
use crate::tunnel::Tunnel;

/// The key of the peer a request came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Remote(pub PublicKey);

/// The stream of an extended CONNECT, given once its response is sent with success — to the first that asks for it, as
/// a request's extensions are shared by its clones.
#[derive(Debug, Clone)]
pub struct OnConnect(Arc<Mutex<Option<oneshot::Receiver<Stream>>>>);

impl OnConnect {
    /// The stream; none where the request was answered otherwise, its session ended first, or it was taken already.
    pub async fn stream(self) -> Option<Stream> {
        let receiver = self.0.lock().ok()?.take()?;
        receiver.await.ok()
    }
}

/// A request's body, read as it comes.
#[derive(Debug)]
pub struct Body(Option<mpsc::Receiver<Result<Bytes, StreamError>>>);

impl http_body::Body for Body {
    type Data = Bytes;
    type Error = StreamError;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, StreamError>>> {
        let Some(receiver) = self.0.as_mut() else {
            return Poll::Ready(None);
        };
        receiver.poll_recv(cx).map(|next| next.map(|read| read.map(Frame::data)))
    }

    fn is_end_stream(&self) -> bool {
        self.0.is_none()
    }
}

/// How many pieces of a request's body are read ahead of the service.
const BODY_AHEAD: usize = 8;

impl Tunnel {
    /// Serves `service` to every peer that reaches this place, till it is closed.
    pub async fn serve<S, B>(&self, service: S)
    where
        S: Service<Request<Body>, Response = Response<B>, Error = Infallible> + Clone + Send + 'static,
        S::Future: Send,
        B: http_body::Body + Send + 'static,
        B::Data: Send,
        B::Error: Send,
    {
        while let Some(incoming) = self.endpoint.accept().await {
            n0_future::task::spawn(session(incoming, service.clone()));
        }
    }
}

/// Serves `service` over the session `incoming` opens, a request at a time in tasks of their own.
async fn session<S, B>(incoming: Incoming, service: S)
where
    S: Service<Request<Body>, Response = Response<B>, Error = Infallible> + Clone + Send + 'static,
    S::Future: Send,
    B: http_body::Body + Send + 'static,
    B::Data: Send,
    B::Error: Send,
{
    let Ok(connection) = incoming.await else { return };
    let remote = Remote(connection.remote_id());
    let built = h3::server::builder()
        .enable_extended_connect(true)
        .build::<_, Bytes>(iroh_h3::Connection::new(connection))
        .await;
    let Ok(mut http) = built else { return };
    while let Ok(Some(resolver)) = http.accept().await {
        let service = service.clone();
        n0_future::task::spawn(async move {
            let Ok((request, stream)) = resolver.resolve_request().await else {
                return;
            };
            let (send, receive) = stream.split();
            answer(request, remote, send, receive, service).await;
        });
    }
}

/// Answers `request` of the peer `remote` with what `service` gives, its stream's halves `send` and `receive`.
async fn answer<S, B>(request: Request<()>, remote: Remote, mut send: impl Sending + Responding, receive: impl Receiving, mut service: S)
where
    S: Service<Request<Body>, Response = Response<B>, Error = Infallible> + Send,
    S::Future: Send,
    B: http_body::Body + Send + 'static,
    B::Data: Send,
    B::Error: Send,
{
    let connect = *request.method() == Method::CONNECT;
    let (parts, ()) = request.into_parts();
    let mut request = Request::from_parts(parts, Body(None));
    request.extensions_mut().insert(remote);
    let mut receive = Some(receive);
    let mut connected = None;
    if connect {
        let (sender, stream) = oneshot::channel();
        request.extensions_mut().insert(OnConnect(Arc::new(Mutex::new(Some(stream)))));
        connected = Some(sender);
    } else if let Some(mut receiving) = receive.take() {
        let (sender, body) = mpsc::channel(BODY_AHEAD);
        *request.body_mut() = Body(Some(body));
        n0_future::task::spawn(async move {
            loop {
                let read = receiving.receive().await.transpose();
                let Some(read) = read else { return };
                if sender.send(read).await.is_err() {
                    return;
                }
            }
        });
    }
    if std::future::poll_fn(|cx| service.poll_ready(cx)).await.is_err() {
        return;
    }
    let Ok(response) = service.call(request).await;
    let (head, body) = response.into_parts();
    let mut body = Box::pin(body);
    let succeeded = head.status.is_success();
    if send.respond(Response::from_parts(head, ())).await.is_err() {
        return;
    }
    if let (Some(connected), Some(receive), true) = (connected, receive.take(), succeeded) {
        let _ = connected.send(carried(send, receive));
        return;
    }
    while let Some(Ok(frame)) = body.frame().await {
        if let Ok(mut data) = frame.into_data()
            && send.send(data.copy_to_bytes(data.remaining())).await.is_err()
        {
            return;
        }
    }
    let _ = send.finish().await;
}

/// The sending half of a server's request stream, which sends its response's head.
pub(crate) trait Responding {
    fn respond(&mut self, head: Response<()>) -> impl Future<Output = Result<(), StreamError>> + Send;
}

impl<S: h3::quic::SendStream<Bytes> + Send + 'static> Responding for h3::server::RequestStream<S, Bytes> {
    fn respond(&mut self, head: Response<()>) -> impl Future<Output = Result<(), StreamError>> + Send {
        self.send_response(head)
    }
}
