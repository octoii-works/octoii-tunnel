//! A trial of the tunnel's WebAssembly in a real browser: a machine on the relay `RELAY` names, serving a request, an
//! echo and a WebSocket's echo, and — over plain HTTP on this machine — the trial's page, which reaches the machine by
//! its key through the relay and reports how each step went. Run it, open what it prints, and read the report.

use std::convert::Infallible;
use std::path::PathBuf;

use axum::routing::{get, post};
use bytes::Bytes;
use futures_util::{SinkExt as _, StreamExt as _};
use http::{Method, Request, Response};
use http_body_util::{BodyExt as _, Full};
use octoii_tunnel::{Body, OnConnect, RelayConfig, RelayUrl, SecretKey, Tunnel, socket};

async fn answer(mut request: Request<Body>) -> Result<Response<Full<Bytes>>, Infallible> {
    if request.method() == Method::CONNECT {
        let connect = request.extensions_mut().remove::<OnConnect>().expect("a stream to come");
        tokio::spawn(async move {
            let Some(stream) = connect.stream().await else { return };
            let mut socket = socket::server(stream).await;
            while let Some(Ok(message)) = socket.next().await {
                if message.is_close() || socket.send(message).await.is_err() {
                    break;
                }
            }
        });
        return Ok(Response::new(Full::default()));
    }
    let body = match request.uri().path() {
        "/who" => Bytes::from_static(b"the machine"),
        _ => request
            .into_body()
            .collect()
            .await
            .map(http_body_util::Collected::to_bytes)
            .unwrap_or_default(),
    };
    Ok(Response::new(Full::new(body)))
}

#[tokio::main]
async fn main() {
    let relay: RelayUrl = std::env::var("RELAY").expect("RELAY names a relay").parse().expect("a URL");
    let machine = Tunnel::builder(SecretKey::generate())
        .relays(vec![RelayConfig::new(relay.clone(), None)])
        .bind()
        .await
        .expect("bound");
    machine.online().await;
    let serving = machine.clone();
    tokio::spawn(async move { serving.serve(tower::service_fn(answer)).await });
    let package = PathBuf::from(std::env::var("PACKAGE").expect("PACKAGE names the bound package"));
    let page = include_str!("trial/index.html")
        .replace("{relay}", relay.as_str())
        .replace("{machine}", &machine.key().to_string());
    let router = axum::Router::new()
        .route("/", get(move || async move { axum::response::Html(page) }))
        .route(
            "/package/{file}",
            get(move |axum::extract::Path(file): axum::extract::Path<String>| {
                let path = package.join(&file);
                async move {
                    let wasm = std::path::Path::new(&file)
                        .extension()
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("wasm"));
                    let kind = if wasm { "application/wasm" } else { "text/javascript" };
                    let bytes = tokio::fs::read(path).await.unwrap_or_default();
                    ([(http::header::CONTENT_TYPE, kind)], bytes)
                }
            }),
        )
        .route(
            "/report",
            post(|body: String| async move {
                println!("report: {body}");
                std::process::exit(0);
                #[allow(unreachable_code)]
                ""
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8794").await.expect("bound");
    println!("open http://127.0.0.1:8794/");
    axum::serve(listener, router).await.expect("served");
}
