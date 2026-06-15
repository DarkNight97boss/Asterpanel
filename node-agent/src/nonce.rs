//! In-memory nonce store for anti-replay. Each job nonce may be accepted once
//! within the retention window (>= the maximum job TTL). A production deployment
//! can back this with Redis for multi-process agents; the interface is the same.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct NonceStore {
    seen: Mutex<HashMap<String, Instant>>,
    ttl: Duration,
}

impl NonceStore {
    pub fn new(ttl: Duration) -> Self {
        Self {
            seen: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    /// Returns true if the nonce is fresh (and records it); false if it was
    /// already seen within the retention window (a replay).
    pub fn check_and_insert(&self, nonce: &str) -> bool {
        let now = Instant::now();
        let mut guard = self.seen.lock().expect("nonce mutex poisoned");
        // Opportunistic GC of expired entries keeps memory bounded.
        guard.retain(|_, &mut seen_at| now.duration_since(seen_at) < self.ttl);
        if guard.contains_key(nonce) {
            return false;
        }
        guard.insert(nonce.to_string(), now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_use_accepts_replay_rejects() {
        let store = NonceStore::new(Duration::from_secs(60));
        assert!(store.check_and_insert("abc"), "first use must be accepted");
        assert!(!store.check_and_insert("abc"), "replay must be rejected");
        assert!(
            store.check_and_insert("def"),
            "distinct nonce must be accepted"
        );
    }
}
