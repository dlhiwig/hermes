//! hermes-core — Rust daemon entry point
//!
//! Responsibilities:
//!   - SONA HTTP server on port 18804
//!   - Health check endpoint
//!   - Trajectory recording & EWC++ endpoints
//!   - skynet-runtime bridge initialization

use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tracing::info;

const SONA_PORT: u16 = 18804;

// ── Shared State ────────────────────────────────────────────────────────────

struct SonaState {
    routing_table_version: u32,
    trajectories_recorded: u64,
    last_ewc_lambda: f32,
    start_time: Instant,
}

impl SonaState {
    fn new() -> Self {
        Self {
            routing_table_version: 0,
            trajectories_recorded: 0,
            last_ewc_lambda: 0.0,
            start_time: Instant::now(),
        }
    }
}

type AppState = Arc<Mutex<SonaState>>;

// ── Request Bodies ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TrajectoryRequest {
    embedding: Vec<f32>,
    reward: f32,
}

#[derive(Deserialize)]
struct EwcRequest {
    steps: Vec<skynet_runtime::TrajectoryStep>,
    lambda: f32,
    decay: f32,
}

// ── Main ────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_target(false)
        .with_level(true)
        .init();

    info!("hermes-core starting -- SONA port {}", SONA_PORT);

    let state: AppState = Arc::new(Mutex::new(SonaState::new()));

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/sona/status", get(sona_status_handler))
        .route("/sona/trajectory", post(sona_trajectory_handler))
        .route("/sona/ewc", post(sona_ewc_handler))
        .route("/sona/stats", get(sona_stats_handler))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], SONA_PORT));
    info!("Listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn health_handler() -> &'static str {
    "OK"
}

async fn sona_status_handler(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let s = state.lock().unwrap();
    let rt_version = skynet_runtime::get_routing_table_version();
    let uptime_secs = s.start_time.elapsed().as_secs();

    Json(serde_json::json!({
        "status": "running",
        "port": SONA_PORT,
        "sona": {
            "routingTableVersion": rt_version,
            "trajectoriesRecorded": s.trajectories_recorded,
            "lastEwcLambda": s.last_ewc_lambda,
            "uptimeSeconds": uptime_secs
        }
    }))
}

async fn sona_trajectory_handler(
    State(state): State<AppState>,
    Json(body): Json<TrajectoryRequest>,
) -> Json<serde_json::Value> {
    let ok = skynet_runtime::sona_record_trajectory(body.embedding, body.reward);

    if ok {
        let mut s = state.lock().unwrap();
        s.trajectories_recorded += 1;
        s.routing_table_version = skynet_runtime::get_routing_table_version();
    }

    Json(serde_json::json!({
        "recorded": ok,
        "trajectoriesRecorded": state.lock().unwrap().trajectories_recorded
    }))
}

async fn sona_ewc_handler(
    State(state): State<AppState>,
    Json(body): Json<EwcRequest>,
) -> Json<serde_json::Value> {
    let result = skynet_runtime::ewc_record_step(&body.steps, body.lambda, body.decay);

    {
        let mut s = state.lock().unwrap();
        s.last_ewc_lambda = result.adaptive_lambda;
    }

    Json(serde_json::json!({
        "totalPenalty": result.total_penalty,
        "paramCount": result.param_count,
        "adaptiveLambda": result.adaptive_lambda,
        "fisherUpdated": result.fisher_updated
    }))
}

async fn sona_stats_handler(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let s = state.lock().unwrap();
    let engine_count = skynet_runtime::get_trajectory_count();
    let rt_version = skynet_runtime::get_routing_table_version();

    Json(serde_json::json!({
        "trajectoriesRecorded": s.trajectories_recorded,
        "engineTrajectoryCount": engine_count,
        "routingTableVersion": rt_version,
        "lastEwcLambda": s.last_ewc_lambda,
        "uptimeSeconds": s.start_time.elapsed().as_secs()
    }))
}
