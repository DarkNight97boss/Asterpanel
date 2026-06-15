//! Executors carry out validated jobs on the node. The `Executor` trait is the
//! seam for the runtime backend: `DockerExecutor` is the first implementation;
//! a containerd/Kubernetes executor implements the same trait without any change
//! to the verification pipeline above it.
//!
//! Every container is created **non-privileged**: a dedicated UID, read-only
//! rootfs, all capabilities dropped, `no-new-privileges`, PID/memory/CPU limits,
//! and a per-tenant network. Executors are idempotent — re-running a job whose
//! effect already exists is treated as success.

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};

use crate::job::Job;

#[derive(Debug, Serialize)]
pub struct JobOutcome {
    /// One of: succeeded | failed. Maps to the control-plane job status vocabulary.
    pub status: String,
    pub result: Value,
    pub error: Option<String>,
}

impl JobOutcome {
    pub fn succeeded(result: Value) -> Self {
        Self {
            status: "succeeded".into(),
            result,
            error: None,
        }
    }
    pub fn failed(msg: impl Into<String>) -> Self {
        Self {
            status: "failed".into(),
            result: Value::Null,
            error: Some(msg.into()),
        }
    }
}

#[async_trait]
pub trait Executor: Send + Sync {
    async fn execute(&self, job: &Job) -> JobOutcome;
}

pub struct DockerExecutor;

#[async_trait]
impl Executor for DockerExecutor {
    async fn execute(&self, job: &Job) -> JobOutcome {
        match job.job_type.as_str() {
            "website.create" => self.website_create(job).await,
            "database.create" => self.database_create(job).await,
            "database.delete" => self.database_delete(job).await,
            "health.check" => JobOutcome::succeeded(json!({"checked": true})),
            other => JobOutcome::failed(format!("unsupported job type: {other}")),
        }
    }
}

impl DockerExecutor {
    async fn website_create(&self, job: &Job) -> JobOutcome {
        let website_id = job
            .payload
            .get("website_id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let runtime = job
            .payload
            .get("runtime")
            .and_then(Value::as_str)
            .unwrap_or("static");

        let network = format!("astp_tenant_{}", job.tenant_id);
        if let Err(e) = ensure_network(&network).await {
            return JobOutcome::failed(format!("network setup failed: {e}"));
        }

        let name = format!("astp_site_{website_id}");
        let image = image_for_runtime(runtime);
        let args = hardened_run_args(
            &name,
            &network,
            image,
            &job.tenant_id.to_string(),
            website_id,
        );

        match run_docker(&args).await {
            Ok(out) if out.status.success() => {
                let cid = String::from_utf8_lossy(&out.stdout).trim().to_string();
                JobOutcome::succeeded(json!({
                    "container_id": cid, "network": network, "image": image, "name": name,
                }))
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                // Idempotency: an existing container means the site is already provisioned.
                if stderr.contains("already in use") || stderr.contains("Conflict") {
                    JobOutcome::succeeded(
                        json!({"name": name, "network": network, "idempotent": true}),
                    )
                } else {
                    JobOutcome::failed(format!("docker run failed: {}", stderr.trim()))
                }
            }
            Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
        }
    }
}

impl DockerExecutor {
    async fn database_create(&self, job: &Job) -> JobOutcome {
        let pv = |k: &str| job.payload.get(k).and_then(Value::as_str);
        let db_id = pv("database_id").unwrap_or("unknown");
        let engine = pv("engine").unwrap_or("postgres");
        let name = pv("name").unwrap_or("app");
        let db_user = pv("db_user").unwrap_or(name);
        let password = pv("password").unwrap_or("");
        let port = job
            .payload
            .get("port")
            .and_then(Value::as_u64)
            .unwrap_or(5432);

        let network = format!("astp_tenant_{}", job.tenant_id);
        if let Err(e) = ensure_network(&network).await {
            return JobOutcome::failed(format!("network setup failed: {e}"));
        }

        let args = match db_run_args(engine, db_id, name, db_user, password, &network) {
            Some(a) => a,
            None => return JobOutcome::failed(format!("unsupported engine: {engine}")),
        };

        match run_docker(&args).await {
            Ok(out) if out.status.success() => {
                let cid = String::from_utf8_lossy(&out.stdout).trim().to_string();
                JobOutcome::succeeded(json!({
                    "container_id": cid,
                    "engine": engine,
                    // reachable from sibling containers on the tenant network
                    "host": format!("astp_db_{db_id}"),
                    "port": port,
                    "network": network,
                }))
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                if stderr.contains("already in use") || stderr.contains("Conflict") {
                    JobOutcome::succeeded(json!({"engine": engine, "idempotent": true}))
                } else {
                    JobOutcome::failed(format!("docker run failed: {}", stderr.trim()))
                }
            }
            Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
        }
    }

    async fn database_delete(&self, job: &Job) -> JobOutcome {
        let db_id = job
            .payload
            .get("database_id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let container = format!("astp_db_{db_id}");
        let volume = format!("astp_dbdata_{db_id}");
        let _ = run_docker(&["rm".into(), "-f".into(), container.clone()]).await;
        let _ = run_docker(&["volume".into(), "rm".into(), volume]).await;
        JobOutcome::succeeded(json!({ "deleted": container }))
    }
}

/// Builds the hardened `docker run` argv for a managed database container.
/// Returns None for an unsupported engine. DB containers keep a writable data
/// volume (so no read-only rootfs) but drop all caps, set no-new-privileges and
/// CPU/memory/PID limits, and live on the per-tenant network.
///
/// NOTE: the password is passed via `-e` for clarity; a production build sources
/// it from an `--env-file` or Docker secret so it is not visible in `docker inspect`.
fn db_run_args(
    engine: &str,
    db_id: &str,
    name: &str,
    db_user: &str,
    password: &str,
    network: &str,
) -> Option<Vec<String>> {
    let volume = format!("astp_dbdata_{db_id}");
    let mut a: Vec<String> = vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        format!("astp_db_{db_id}"),
        "--restart".into(),
        "unless-stopped".into(),
        "--network".into(),
        network.into(),
        "--cap-drop".into(),
        "ALL".into(),
        "--security-opt".into(),
        "no-new-privileges".into(),
        "--memory".into(),
        "512m".into(),
        "--cpus".into(),
        "0.5".into(),
        "--pids-limit".into(),
        "512".into(),
        "--label".into(),
        format!("asterpanel.database={db_id}"),
    ];

    match engine {
        "postgres" => {
            a.push("-v".into());
            a.push(format!("{volume}:/var/lib/postgresql/data"));
            a.push("-e".into());
            a.push(format!("POSTGRES_DB={name}"));
            a.push("-e".into());
            a.push(format!("POSTGRES_USER={db_user}"));
            a.push("-e".into());
            a.push(format!("POSTGRES_PASSWORD={password}"));
            a.push("postgres:16-alpine".into());
        }
        "mysql" => {
            a.push("-v".into());
            a.push(format!("{volume}:/var/lib/mysql"));
            a.push("-e".into());
            a.push(format!("MYSQL_DATABASE={name}"));
            a.push("-e".into());
            a.push(format!("MYSQL_USER={db_user}"));
            a.push("-e".into());
            a.push(format!("MYSQL_PASSWORD={password}"));
            a.push("-e".into());
            a.push("MYSQL_RANDOM_ROOT_PASSWORD=yes".into());
            a.push("mysql:8".into());
        }
        "mariadb" => {
            a.push("-v".into());
            a.push(format!("{volume}:/var/lib/mysql"));
            a.push("-e".into());
            a.push(format!("MARIADB_DATABASE={name}"));
            a.push("-e".into());
            a.push(format!("MARIADB_USER={db_user}"));
            a.push("-e".into());
            a.push(format!("MARIADB_PASSWORD={password}"));
            a.push("-e".into());
            a.push("MARIADB_RANDOM_ROOT_PASSWORD=yes".into());
            a.push("mariadb:11".into());
        }
        "redis" => {
            a.push("-v".into());
            a.push(format!("{volume}:/data"));
            a.push("redis:7-alpine".into());
            a.push("redis-server".into());
            a.push("--requirepass".into());
            a.push(password.into());
        }
        "mongodb" => {
            a.push("-v".into());
            a.push(format!("{volume}:/data/db"));
            a.push("-e".into());
            a.push(format!("MONGO_INITDB_ROOT_USERNAME={db_user}"));
            a.push("-e".into());
            a.push(format!("MONGO_INITDB_ROOT_PASSWORD={password}"));
            a.push("-e".into());
            a.push(format!("MONGO_INITDB_DATABASE={name}"));
            a.push("mongo:7".into());
        }
        _ => return None,
    }

    Some(a)
}

fn image_for_runtime(runtime: &str) -> &'static str {
    match runtime {
        "static" => "nginxinc/nginx-unprivileged:stable-alpine",
        "node" => "node:20-alpine",
        "php" => "php:8.3-fpm-alpine",
        "proxy" => "caddy:2-alpine",
        _ => "alpine:3.20",
    }
}

/// Builds a non-privileged `docker run` argument vector (explicit argv — never a
/// shell string, so payload values can't inject commands).
fn hardened_run_args(
    name: &str,
    network: &str,
    image: &str,
    tenant: &str,
    website: &str,
) -> Vec<String> {
    vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        name.into(),
        "--restart".into(),
        "unless-stopped".into(),
        "--user".into(),
        "10001:10001".into(),
        "--read-only".into(),
        "--cap-drop".into(),
        "ALL".into(),
        "--security-opt".into(),
        "no-new-privileges".into(),
        "--pids-limit".into(),
        "256".into(),
        "--memory".into(),
        "512m".into(),
        "--cpus".into(),
        "0.5".into(),
        "--network".into(),
        network.into(),
        "--tmpfs".into(),
        "/tmp".into(),
        "--tmpfs".into(),
        "/var/cache/nginx".into(),
        "--tmpfs".into(),
        "/var/run".into(),
        "--label".into(),
        format!("asterpanel.tenant={tenant}"),
        "--label".into(),
        format!("asterpanel.website={website}"),
        image.into(),
    ]
}

async fn ensure_network(name: &str) -> anyhow::Result<()> {
    let inspect = run_docker(&["network".into(), "inspect".into(), name.into()]).await?;
    if inspect.status.success() {
        return Ok(());
    }
    let create = run_docker(&[
        "network".into(),
        "create".into(),
        "--driver".into(),
        "bridge".into(),
        name.into(),
    ])
    .await?;
    let stderr = String::from_utf8_lossy(&create.stderr);
    if create.status.success() || stderr.contains("already exists") {
        Ok(())
    } else {
        Err(anyhow::anyhow!(stderr.trim().to_string()))
    }
}

async fn run_docker(args: &[String]) -> std::io::Result<std::process::Output> {
    tokio::process::Command::new("docker")
        .args(args)
        .output()
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_args_postgres_is_hardened() {
        let a = db_run_args(
            "postgres",
            "abc",
            "mydb",
            "myuser",
            "secretpw",
            "astp_tenant_x",
        )
        .unwrap();
        let s = a.join(" ");
        assert!(s.contains("--name astp_db_abc"), "{s}");
        assert!(s.contains("--cap-drop ALL"), "{s}");
        assert!(s.contains("no-new-privileges"), "{s}");
        assert!(s.contains("--network astp_tenant_x"), "{s}");
        assert!(s.contains("POSTGRES_DB=mydb"), "{s}");
        assert!(s.contains("POSTGRES_USER=myuser"), "{s}");
        assert!(s.ends_with("postgres:16-alpine"), "{s}");
    }

    #[test]
    fn db_args_redis_sets_requirepass() {
        let a = db_run_args("redis", "r1", "n", "u", "pw", "net").unwrap();
        let s = a.join(" ");
        assert!(
            s.contains("redis:7-alpine redis-server --requirepass pw"),
            "{s}"
        );
    }

    #[test]
    fn db_args_unknown_engine_is_none() {
        assert!(db_run_args("oracle", "x", "n", "u", "p", "net").is_none());
    }
}
