//! Reports job outcomes back to the control plane. Best-effort: a failed
//! callback is logged, not fatal — the control plane also reconciles job state.

use serde_json::json;
use uuid::Uuid;

use crate::executor::JobOutcome;

pub struct Callback {
    base_url: String,
    client: reqwest::Client,
}

impl Callback {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url,
            client: reqwest::Client::new(),
        }
    }

    pub async fn report(&self, job_id: Uuid, outcome: &JobOutcome) {
        let url = format!("{}/internal/agent/jobs/{}/status", self.base_url, job_id);
        let body = json!({
            "status": outcome.status,
            "result": outcome.result,
            "error": outcome.error,
        });
        match self.client.post(&url).json(&body).send().await {
            Ok(resp) if resp.status().is_success() => {
                tracing::info!(%job_id, status = %outcome.status, "reported job status");
            }
            Ok(resp) => {
                tracing::warn!(%job_id, code = %resp.status(), "control plane rejected status report");
            }
            Err(e) => {
                tracing::warn!(%job_id, error = %e, "status callback failed");
            }
        }
    }
}
