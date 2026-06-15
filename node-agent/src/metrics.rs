//! Node resource metrics: CPU%, memory and disk. Collectors read Linux `/proc`
//! and `df`; the *parsing* is pure and unit-tested, so the numbers are
//! trustworthy even though the file/command I/O only does anything on a real
//! node. Samples are pushed to the control plane on a fixed interval.

use serde_json::json;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CpuTimes {
    pub idle: u64,
    pub total: u64,
}

/// Parses the aggregate `cpu` line of /proc/stat into idle and total jiffies.
pub fn parse_proc_stat(content: &str) -> Option<CpuTimes> {
    let line = content.lines().find(|l| l.starts_with("cpu "))?;
    let vals: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|v| v.parse().ok())
        .collect();
    if vals.len() < 5 {
        return None;
    }
    // user nice system idle iowait irq softirq steal …
    let idle = vals[3] + vals[4]; // idle + iowait
    let total: u64 = vals.iter().sum();
    Some(CpuTimes { idle, total })
}

/// CPU utilisation percent between two /proc/stat samples (0 when no delta).
pub fn cpu_pct(prev: CpuTimes, cur: CpuTimes) -> f64 {
    let dt = cur.total.saturating_sub(prev.total);
    let di = cur.idle.saturating_sub(prev.idle);
    if dt == 0 {
        return 0.0;
    }
    ((dt - di) as f64 / dt as f64) * 100.0
}

/// Parses /proc/meminfo into (used_mb, total_mb), preferring MemAvailable.
pub fn parse_meminfo(content: &str) -> Option<(i64, i64)> {
    let kb = |key: &str| -> Option<i64> {
        content
            .lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse::<i64>().ok())
    };
    let total = kb("MemTotal:")?;
    let avail = kb("MemAvailable:").or_else(|| kb("MemFree:"))?;
    let total_mb = total / 1024;
    let used_mb = (total - avail).max(0) / 1024;
    Some((used_mb, total_mb))
}

/// Parses `df -kP <path>` output (1K blocks) into (used_gb, total_gb).
pub fn parse_df(content: &str) -> Option<(i64, i64)> {
    // line 0 is the header; the data line columns are:
    // filesystem  1024-blocks  used  available  capacity  mount
    let line = content.lines().nth(1)?;
    let cols: Vec<&str> = line.split_whitespace().collect();
    if cols.len() < 4 {
        return None;
    }
    let total_kb: i64 = cols[1].parse().ok()?;
    let used_kb: i64 = cols[2].parse().ok()?;
    Some((used_kb / 1024 / 1024, total_kb / 1024 / 1024))
}

/// Parses the 1-minute load average (first field of /proc/loadavg).
pub fn parse_loadavg(content: &str) -> Option<f64> {
    content.split_whitespace().next().and_then(|v| v.parse().ok())
}

#[derive(Debug, Default)]
pub struct Snapshot {
    pub cpu_pct: f64,
    pub mem_used_mb: i64,
    pub mem_total_mb: i64,
    pub disk_used_gb: i64,
    pub disk_total_gb: i64,
    pub load1: f64,
    pub containers: i64,
}

/// Reads the current CPU sample (None on non-Linux / unreadable /proc).
pub async fn read_cpu_times() -> Option<CpuTimes> {
    let c = tokio::fs::read_to_string("/proc/stat").await.ok()?;
    parse_proc_stat(&c)
}

pub async fn read_mem() -> (i64, i64) {
    match tokio::fs::read_to_string("/proc/meminfo").await {
        Ok(c) => parse_meminfo(&c).unwrap_or((0, 0)),
        Err(_) => (0, 0),
    }
}

pub async fn read_disk() -> (i64, i64) {
    match tokio::process::Command::new("df")
        .args(["-kP", "/"])
        .output()
        .await
    {
        Ok(o) if o.status.success() => parse_df(&String::from_utf8_lossy(&o.stdout)).unwrap_or((0, 0)),
        _ => (0, 0),
    }
}

pub async fn read_loadavg() -> f64 {
    match tokio::fs::read_to_string("/proc/loadavg").await {
        Ok(c) => parse_loadavg(&c).unwrap_or(0.0),
        Err(_) => 0.0,
    }
}

/// Pushes snapshots to the control plane's internal metrics ingest endpoint.
/// Best-effort: a failed post is logged, never fatal (the next tick retries).
pub struct MetricsReporter {
    base_url: String,
    node_id: Uuid,
    client: reqwest::Client,
}

impl MetricsReporter {
    pub fn new(base_url: String, node_id: Uuid) -> Self {
        Self {
            base_url,
            node_id,
            client: reqwest::Client::new(),
        }
    }

    pub async fn report(&self, snap: &Snapshot) {
        let url = format!(
            "{}/internal/agent/nodes/{}/metrics",
            self.base_url, self.node_id
        );
        let body = json!({
            "cpu_pct": snap.cpu_pct,
            "mem_used_mb": snap.mem_used_mb,
            "mem_total_mb": snap.mem_total_mb,
            "disk_used_gb": snap.disk_used_gb,
            "disk_total_gb": snap.disk_total_gb,
            "load1": snap.load1,
            "containers": snap.containers,
        });
        match self.client.post(&url).json(&body).send().await {
            Ok(resp) if resp.status().is_success() => {
                tracing::debug!(node_id = %self.node_id, "reported metrics")
            }
            Ok(resp) => tracing::warn!(code = %resp.status(), "metrics ingest rejected"),
            Err(e) => tracing::warn!(error = %e, "metrics report failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proc_stat_idle_and_total() {
        let c = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 ...\n";
        let t = parse_proc_stat(c).unwrap();
        assert_eq!(t.idle, 850); // idle 800 + iowait 50
        assert_eq!(t.total, 1000);
    }

    #[test]
    fn cpu_pct_from_two_samples() {
        let prev = CpuTimes {
            idle: 850,
            total: 1000,
        };
        let cur = CpuTimes {
            idle: 1700,
            total: 2000,
        };
        // 1000 total delta, 850 idle delta → 15% busy
        assert!((cpu_pct(prev, cur) - 15.0).abs() < 1e-9);
        // no delta → 0, never NaN
        assert_eq!(cpu_pct(cur, cur), 0.0);
    }

    #[test]
    fn meminfo_uses_available() {
        let c = "MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\n";
        let (used, total) = parse_meminfo(c).unwrap();
        assert_eq!(total, 16000); // 16384000 kB / 1024
        assert_eq!(used, 8000); // (16384000 - 8192000) / 1024
    }

    #[test]
    fn df_parses_used_and_total() {
        let c = "Filesystem 1024-blocks      Used Available Capacity Mounted\n/dev/sda1  104857600  52428800  52428800      50% /\n";
        let (used, total) = parse_df(c).unwrap();
        assert_eq!(total, 100); // 104857600 KiB → 100 GiB
        assert_eq!(used, 50);
    }

    #[test]
    fn loadavg_takes_first_field() {
        assert_eq!(parse_loadavg("0.42 0.31 0.28 1/123 4567"), Some(0.42));
        assert_eq!(parse_loadavg(""), None);
    }
}
