//! hermes-core — Rust daemon entry point
//!
//! Responsibilities:
//!   - SONA HTTP server on port 18804
//!   - Health check endpoint
//!   - skynet-runtime bridge initialization

use axum::{routing::get, Router};
use std::net::SocketAddr;
use tracing::{info, warn};

const SONA_PORT: u16 = 18804;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_target(false)
        .with_level(true)
        .init();

    info!("🧠 hermes-core starting — SONA port {}", SONA_PORT);

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/sona/status", get(sona_status_handler));

    let addr = SocketAddr::from(([127, 0, 0, 1], SONA_PORT));
    info!("Listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn health_handler() -> &'static str {
    "OK"
}

async fn sona_status_handler() -> axum::Json<serde_json::Value> {
    // TODO: Query SONA daemon state (routing table version, buffer size, etc.)
    axum::Json(serde_json::json!({
        "status": "running",
        "port": SONA_PORT,
        "sona": {
            "routingTableVersion": 0,
            "trajectoryBufferSize": 0,
            "taskAge": 0
        }
    }))
}
