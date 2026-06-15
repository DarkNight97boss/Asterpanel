//! The signed job envelope (mirror of the control plane's `jobs.Job`).

use chrono::{DateTime, Utc};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
pub struct Job {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub job_type: String,
    pub node_id: Uuid,
    pub tenant_id: Uuid,
    pub nonce: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub payload: serde_json::Value,
}

impl Job {
    /// True if `now` is past the job's TTL.
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        now > self.expires_at
    }

    /// True if the job claims to have been issued too far in the future
    /// (beyond the allowed clock skew) — rejects forged/clock-confused jobs.
    pub fn issued_in_future(&self, now: DateTime<Utc>, skew_secs: i64) -> bool {
        self.issued_at > now + chrono::Duration::seconds(skew_secs)
    }
}
