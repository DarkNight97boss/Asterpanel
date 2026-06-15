//! Agent configuration, loaded from the environment.

use anyhow::Result;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct Config {
    /// This node's id (must match `server_nodes.id` so job `node_id` checks pass).
    pub node_id: Option<Uuid>,
    /// Dev escape hatch: accept jobs for any node. MUST be false in production.
    pub allow_any_node: bool,
    pub listen_addr: String,
    pub tls_cert_path: String,
    pub tls_key_path: String,
    pub ca_cert_path: String,
    /// PEM SubjectPublicKeyInfo Ed25519 key the control plane signs jobs with.
    pub trusted_job_pubkey_path: String,
    /// Base URL the agent calls back with job status.
    pub callback_url: String,
    /// Allowed clock skew (seconds) when validating job timestamps.
    pub clock_skew_secs: i64,
    pub agent_version: String,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let node_id = match std::env::var("AGENT_NODE_ID") {
            Ok(v) => Uuid::parse_str(&v).ok(), // non-uuid (e.g. dev placeholder) => None
            Err(_) => None,
        };
        Ok(Self {
            node_id,
            allow_any_node: env_or("AGENT_ALLOW_ANY_NODE", "false") == "true",
            listen_addr: env_or("AGENT_LISTEN_ADDR", "0.0.0.0:7443"),
            tls_cert_path: env_or("AGENT_TLS_CERT_PATH", "/secrets/agent/agent.crt"),
            tls_key_path: env_or("AGENT_TLS_KEY_PATH", "/secrets/agent/agent.key"),
            ca_cert_path: env_or("AGENT_CA_CERT_PATH", "/secrets/ca/ca.crt"),
            trusted_job_pubkey_path: env_or(
                "AGENT_TRUSTED_JOB_PUBKEY_PATH",
                "/secrets/job-signing/ed25519.pub",
            ),
            callback_url: env_or(
                "AGENT_CONTROL_PLANE_CALLBACK_URL",
                "http://control-plane:8080",
            ),
            clock_skew_secs: env_or("AGENT_CLOCK_SKEW_SECS", "5").parse().unwrap_or(5),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
        })
    }
}
