//! AsterPanel node agent.
//!
//! Accepts signed jobs from the control plane over mTLS, verifies them
//! (Ed25519 signature → node match → TTL → nonce anti-replay), acknowledges,
//! then executes idempotently and reports the outcome back.

mod callback;
mod config;
mod executor;
mod job;
mod metrics;
mod nonce;
mod tls;
mod verify;

use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use serde_json::json;

use crate::callback::Callback;
use crate::config::Config;
use crate::executor::{DockerExecutor, Executor};
use crate::job::Job;
use crate::nonce::NonceStore;
use crate::verify::JobVerifier;

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    verifier: Arc<JobVerifier>,
    nonces: Arc<NonceStore>,
    executor: Arc<dyn Executor>,
    callback: Arc<Callback>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .json()
        .init();

    let config = Config::from_env()?;
    tracing::info!(
        node_id = ?config.node_id,
        version = %config.agent_version,
        allow_any_node = config.allow_any_node,
        addr = %config.listen_addr,
        "starting node agent"
    );
    if config.allow_any_node {
        tracing::warn!("AGENT_ALLOW_ANY_NODE=true — accepting jobs for ANY node id (dev only)");
    }

    let verifier = JobVerifier::from_pem_file(&config.trusted_job_pubkey_path)?;
    let tls_config = tls::server_config(
        &config.tls_cert_path,
        &config.tls_key_path,
        &config.ca_cert_path,
    )?;

    let callback = Callback::new(config.callback_url.clone());
    let state = AppState {
        // Nonce retention must exceed the maximum job TTL.
        nonces: Arc::new(NonceStore::new(Duration::from_secs(300))),
        verifier: Arc::new(verifier),
        executor: Arc::new(DockerExecutor),
        callback: Arc::new(callback),
        config: Arc::new(config.clone()),
    };

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/jobs", post(handle_job))
        .with_state(state);

    // Background metrics loop: sample CPU/mem/disk every 15s and push to the
    // control plane. Only runs when this agent has a node id (skipped in the
    // allow-any-node dev mode without one).
    if let Some(node_id) = config.node_id {
        let reporter = metrics::MetricsReporter::new(config.callback_url.clone(), node_id);
        tokio::spawn(async move {
            let mut prev = metrics::read_cpu_times().await;
            let mut tick = tokio::time::interval(Duration::from_secs(15));
            tick.tick().await; // consume the immediate first tick
            loop {
                tick.tick().await;
                let cur = metrics::read_cpu_times().await;
                let pct = match (prev, cur) {
                    (Some(p), Some(c)) => metrics::cpu_pct(p, c),
                    _ => 0.0,
                };
                prev = cur;
                let (mem_used_mb, mem_total_mb) = metrics::read_mem().await;
                let (disk_used_gb, disk_total_gb) = metrics::read_disk().await;
                let load1 = metrics::read_loadavg().await;
                reporter
                    .report(&metrics::Snapshot {
                        cpu_pct: pct,
                        mem_used_mb,
                        mem_total_mb,
                        disk_used_gb,
                        disk_total_gb,
                        load1,
                        containers: 0,
                    })
                    .await;
            }
        });
    }

    let addr: std::net::SocketAddr = config.listen_addr.parse()?;
    let rustls_config = axum_server::tls_rustls::RustlsConfig::from_config(tls_config);
    tracing::info!(%addr, "agent listening (mTLS)");
    axum_server::bind_rustls(addr, rustls_config)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}

async fn handle_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    // 1. Signature header.
    let signature = match headers
        .get("X-Asterpanel-Signature")
        .and_then(|v| v.to_str().ok())
    {
        Some(s) => s.strip_prefix("ed25519=").unwrap_or(s).to_string(),
        None => return reject(StatusCode::UNAUTHORIZED, "missing signature"),
    };

    // 2. Verify over the exact received bytes.
    if state.verifier.verify(&body, &signature).is_err() {
        tracing::warn!("rejected job: invalid signature");
        return reject(StatusCode::UNAUTHORIZED, "invalid signature");
    }

    // 3. Parse.
    let job: Job = match serde_json::from_slice(&body) {
        Ok(j) => j,
        Err(e) => return reject(StatusCode::BAD_REQUEST, &format!("invalid job: {e}")),
    };

    let now = Utc::now();

    // 4. This-node check.
    if !state.config.allow_any_node {
        match state.config.node_id {
            Some(nid) if nid == job.node_id => {}
            _ => {
                tracing::warn!(job_id = %job.id, "rejected job: wrong node");
                return reject(StatusCode::FORBIDDEN, "job is not for this node");
            }
        }
    }

    // 5. Freshness: not expired, not implausibly future-dated.
    if job.is_expired(now) {
        return reject(StatusCode::GONE, "job expired");
    }
    if job.issued_in_future(now, state.config.clock_skew_secs) {
        return reject(StatusCode::BAD_REQUEST, "job issued in the future");
    }

    // 6. Anti-replay.
    if !state.nonces.check_and_insert(&job.nonce) {
        tracing::warn!(job_id = %job.id, "rejected job: replayed nonce");
        return reject(StatusCode::CONFLICT, "replay detected");
    }

    // 7. Acknowledge, then execute asynchronously and report status.
    let job_id = job.id;
    let job_type = job.job_type.clone();
    let worker = state.clone();
    tokio::spawn(async move {
        tracing::info!(%job_id, job_type = %job_type, "executing job");
        let outcome = worker.executor.execute(&job).await;
        worker.callback.report(job_id, &outcome).await;
    });

    (
        StatusCode::ACCEPTED,
        Json(json!({"accepted": true, "job_id": job_id})),
    )
        .into_response()
}

fn reject(code: StatusCode, msg: &str) -> axum::response::Response {
    (code, Json(json!({"accepted": false, "error": msg}))).into_response()
}
