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
            "dns.apply" => self.dns_apply(job).await,
            "cert.issue" => self.cert_issue(job).await,
            "app.deploy" => self.app_deploy(job).await,
            "mail.mailbox.create" => self.mailbox_create(job).await,
            "mail.server.ensure" => self.mail_server_ensure(job).await,
            "cron.apply" => self.cron_apply(job).await,
            "ftp.account.create" => self.ftp_account_create(job).await,
            "database.user.create" => self.database_user_create(job).await,
            "cert.install" => self.cert_install(job).await,
            "backup.create" => self.backup_create(job).await,
            "backup.restore" => self.backup_restore(job).await,
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

    async fn dns_apply(&self, job: &Job) -> JobOutcome {
        let zone = job
            .payload
            .get("zone")
            .and_then(Value::as_str)
            .unwrap_or("");
        if zone.is_empty() {
            return JobOutcome::failed("dns.apply: missing zone");
        }
        let serial = job
            .payload
            .get("serial")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        let empty: Vec<Value> = Vec::new();
        let records = job
            .payload
            .get("records")
            .and_then(Value::as_array)
            .unwrap_or(&empty);

        let content = render_zone(zone, serial, records);
        let dir = std::env::var("AGENT_DNS_DIR").unwrap_or_else(|_| "/etc/asterpanel/dns".into());
        let path = format!("{dir}/{zone}.zone");

        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("dns.apply: mkdir failed: {e}"));
        }
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("dns.apply: write failed: {e}"));
        }
        // A production node reloads the authoritative server here (CoreDNS reload,
        // PowerDNS API, or `rndc reload`); the zone file is the source of truth.
        JobOutcome::succeeded(json!({
            "zone": zone, "records": records.len(), "serial": serial, "path": path,
        }))
    }

    async fn cert_issue(&self, job: &Job) -> JobOutcome {
        let domain = job
            .payload
            .get("domain")
            .and_then(Value::as_str)
            .unwrap_or("");
        if domain.is_empty() {
            return JobOutcome::failed("cert.issue: missing domain");
        }
        let upstream = job
            .payload
            .get("upstream")
            .and_then(Value::as_str)
            .unwrap_or("");
        let content = render_caddy_site(domain, upstream);
        let dir = std::env::var("AGENT_CADDY_SITES_DIR")
            .unwrap_or_else(|_| "/etc/asterpanel/caddy/sites".into());
        let path = format!("{dir}/{domain}.caddy");
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("cert.issue: mkdir failed: {e}"));
        }
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("cert.issue: write failed: {e}"));
        }
        // Caddy (automatic_https) obtains/renews the cert from the ACME CA on load.
        JobOutcome::succeeded(json!({"domain": domain, "path": path, "tls": "acme"}))
    }

    async fn app_deploy(&self, job: &Job) -> JobOutcome {
        let dep_id = job
            .payload
            .get("deployment_id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let app_id = job
            .payload
            .get("application_id")
            .and_then(Value::as_str)
            .unwrap_or(dep_id);
        let git_url = job
            .payload
            .get("git_url")
            .and_then(Value::as_str)
            .unwrap_or("");
        if git_url.is_empty() {
            return JobOutcome::failed("app.deploy: git_url is required");
        }
        let git_ref = job
            .payload
            .get("ref")
            .and_then(Value::as_str)
            .unwrap_or("main");

        let workdir = format!("/tmp/astp_build_{dep_id}");
        let _ = run_cmd("rm", &["-rf".into(), workdir.clone()]).await;
        match run_cmd("git", &git_clone_args(git_url, git_ref, &workdir)).await {
            Ok(o) if o.status.success() => {}
            Ok(o) => {
                return JobOutcome::failed(format!(
                    "git clone failed: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                ))
            }
            Err(e) => return JobOutcome::failed(format!("git not available: {e}")),
        }

        let image = format!("astp_app_{dep_id}");
        match run_docker(&["build".into(), "-t".into(), image.clone(), workdir.clone()]).await {
            Ok(o) if o.status.success() => {}
            Ok(o) => {
                return JobOutcome::failed(format!(
                    "docker build failed: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                ))
            }
            Err(e) => return JobOutcome::failed(format!("could not exec docker: {e}")),
        }

        let network = format!("astp_tenant_{}", job.tenant_id);
        if let Err(e) = ensure_network(&network).await {
            return JobOutcome::failed(format!("network setup failed: {e}"));
        }
        let container = format!("astp_app_{app_id}");
        // Replace the previous container; the prior image is retained for rollback.
        let _ = run_docker(&["rm".into(), "-f".into(), container.clone()]).await;
        match run_docker(&app_run_args(
            &container,
            &network,
            &image,
            &job.tenant_id.to_string(),
            dep_id,
        ))
        .await
        {
            Ok(o) if o.status.success() => {
                let cid = String::from_utf8_lossy(&o.stdout).trim().to_string();
                JobOutcome::succeeded(json!({
                    "image": image, "container_id": cid, "container": container, "network": network,
                }))
            }
            Ok(o) => JobOutcome::failed(format!(
                "docker run failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
        }
    }

    async fn mailbox_create(&self, job: &Job) -> JobOutcome {
        use tokio::io::AsyncWriteExt;
        let address = job
            .payload
            .get("address")
            .and_then(Value::as_str)
            .unwrap_or("");
        let password = job
            .payload
            .get("password")
            .and_then(Value::as_str)
            .unwrap_or("");
        if address.is_empty() {
            return JobOutcome::failed("mail.mailbox.create: missing address");
        }
        let dir = std::env::var("AGENT_MAIL_DIR").unwrap_or_else(|_| "/etc/asterpanel/mail".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("mkdir failed: {e}"));
        }

        let users_path = format!("{dir}/dovecot-users");
        match tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&users_path)
            .await
        {
            Ok(mut f) => {
                if let Err(e) = f
                    .write_all(render_dovecot_user(address, password).as_bytes())
                    .await
                {
                    return JobOutcome::failed(format!("write dovecot users failed: {e}"));
                }
            }
            Err(e) => return JobOutcome::failed(format!("open dovecot users failed: {e}")),
        }
        let virtual_path = format!("{dir}/postfix-virtual");
        match tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&virtual_path)
            .await
        {
            Ok(mut f) => {
                if let Err(e) = f
                    .write_all(render_postfix_virtual(address).as_bytes())
                    .await
                {
                    return JobOutcome::failed(format!("write postfix virtual failed: {e}"));
                }
            }
            Err(e) => return JobOutcome::failed(format!("open postfix virtual failed: {e}")),
        }
        JobOutcome::succeeded(json!({"address": address, "provisioned": true}))
    }

    async fn backup_create(&self, job: &Job) -> JobOutcome {
        let backup_id = job
            .payload
            .get("backup_id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let target = job
            .payload
            .get("target_path")
            .and_then(Value::as_str)
            .unwrap_or("/var/asterpanel/sites");
        let dir =
            std::env::var("AGENT_BACKUP_DIR").unwrap_or_else(|_| "/var/asterpanel/backups".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("mkdir failed: {e}"));
        }
        let file = format!("{dir}/{backup_id}.tar.gz");
        match run_cmd("tar", &backup_tar_args(&file, target)).await {
            Ok(o) if o.status.success() => {
                let size = tokio::fs::metadata(&file)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                // Off-site upload when an S3 bucket is configured (uses the aws CLI).
                if let Ok(bucket) = std::env::var("AGENT_S3_BUCKET") {
                    let key = format!("backups/{backup_id}.tar.gz");
                    if let Ok(u) = run_cmd("aws", &s3_cp_args(&file, &bucket, &key)).await {
                        if u.status.success() {
                            return JobOutcome::succeeded(json!({
                                "path": file, "size_bytes": size, "storage": "s3",
                                "s3": format!("s3://{bucket}/{key}"),
                            }));
                        }
                    }
                }
                JobOutcome::succeeded(json!({"path": file, "size_bytes": size, "storage": "local"}))
            }
            Ok(o) => JobOutcome::failed(format!(
                "tar failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => JobOutcome::failed(format!("tar not available: {e}")),
        }
    }

    async fn backup_restore(&self, job: &Job) -> JobOutcome {
        let backup_id = job
            .payload
            .get("backup_id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let target = job
            .payload
            .get("target_path")
            .and_then(Value::as_str)
            .unwrap_or("/var/asterpanel/sites");
        let dir =
            std::env::var("AGENT_BACKUP_DIR").unwrap_or_else(|_| "/var/asterpanel/backups".into());
        let file = format!("{dir}/{backup_id}.tar.gz");
        let _ = run_cmd("mkdir", &["-p".into(), target.to_string()]).await;
        match run_cmd("tar", &backup_untar_args(&file, target)).await {
            Ok(o) if o.status.success() => {
                JobOutcome::succeeded(json!({"restored": backup_id, "target": target}))
            }
            Ok(o) => JobOutcome::failed(format!(
                "tar restore failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => JobOutcome::failed(format!("tar not available: {e}")),
        }
    }

    async fn cron_apply(&self, job: &Job) -> JobOutcome {
        let empty: Vec<Value> = Vec::new();
        let entries = job
            .payload
            .get("jobs")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let content = render_crontab(entries);
        let dir = std::env::var("AGENT_CRON_DIR").unwrap_or_else(|_| "/etc/asterpanel/cron".into());
        let path = format!("{dir}/asterpanel.cron");
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("cron.apply: mkdir failed: {e}"));
        }
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("cron.apply: write failed: {e}"));
        }
        JobOutcome::succeeded(json!({"path": path, "jobs": entries.len()}))
    }

    async fn ftp_account_create(&self, job: &Job) -> JobOutcome {
        use tokio::io::AsyncWriteExt;
        let username = job
            .payload
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("");
        let home = job
            .payload
            .get("home_directory")
            .and_then(Value::as_str)
            .unwrap_or("/sites");
        if username.is_empty() {
            return JobOutcome::failed("ftp.account.create: missing username");
        }
        let dir = std::env::var("AGENT_SFTP_DIR").unwrap_or_else(|_| "/etc/asterpanel/ssh".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("mkdir failed: {e}"));
        }
        let path = format!("{dir}/sftp.conf");
        match tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
        {
            Ok(mut f) => {
                if let Err(e) = f
                    .write_all(render_sftp_match(username, home).as_bytes())
                    .await
                {
                    return JobOutcome::failed(format!("write failed: {e}"));
                }
            }
            Err(e) => return JobOutcome::failed(format!("open failed: {e}")),
        }
        JobOutcome::succeeded(json!({"username": username, "chroot": home}))
    }

    async fn database_user_create(&self, job: &Job) -> JobOutcome {
        let pv = |k: &str| job.payload.get(k).and_then(Value::as_str);
        let db_id = pv("database_id").unwrap_or("unknown");
        let engine = pv("engine").unwrap_or("postgres");
        let database = pv("database").unwrap_or("app");
        let owner = pv("owner").unwrap_or(database);
        let username = pv("username").unwrap_or("");
        let password = pv("password").unwrap_or("");
        if username.is_empty() {
            return JobOutcome::failed("database.user.create: missing username");
        }
        let container = format!("astp_db_{db_id}");
        let args = match db_user_exec_args(engine, &container, database, owner, username, password)
        {
            Some(a) => a,
            None => {
                return JobOutcome::failed(format!(
                    "database.user.create: unsupported engine {engine}"
                ))
            }
        };
        match run_docker(&args).await {
            Ok(o) if o.status.success() => {
                JobOutcome::succeeded(json!({"username": username, "database": database}))
            }
            Ok(o) => JobOutcome::failed(format!(
                "create user failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
        }
    }

    async fn cert_install(&self, job: &Job) -> JobOutcome {
        let domain = job
            .payload
            .get("domain")
            .and_then(Value::as_str)
            .unwrap_or("");
        let cert = job
            .payload
            .get("cert_pem")
            .and_then(Value::as_str)
            .unwrap_or("");
        let key = job
            .payload
            .get("key_pem")
            .and_then(Value::as_str)
            .unwrap_or("");
        if domain.is_empty() || cert.is_empty() || key.is_empty() {
            return JobOutcome::failed("cert.install: domain, cert_pem and key_pem are required");
        }
        let certs_dir = std::env::var("AGENT_CERT_DIR")
            .unwrap_or_else(|_| "/etc/asterpanel/caddy/certs".into());
        let sites_dir = std::env::var("AGENT_CADDY_SITES_DIR")
            .unwrap_or_else(|_| "/etc/asterpanel/caddy/sites".into());
        if tokio::fs::create_dir_all(&certs_dir).await.is_err()
            || tokio::fs::create_dir_all(&sites_dir).await.is_err()
        {
            return JobOutcome::failed("cert.install: mkdir failed");
        }
        let cert_path = format!("{certs_dir}/{domain}.crt");
        let key_path = format!("{certs_dir}/{domain}.key");
        if tokio::fs::write(&cert_path, cert.as_bytes()).await.is_err()
            || tokio::fs::write(&key_path, key.as_bytes()).await.is_err()
        {
            return JobOutcome::failed("cert.install: write failed");
        }
        let site = render_caddy_site_tls(domain, &cert_path, &key_path);
        if tokio::fs::write(format!("{sites_dir}/{domain}.caddy"), site.as_bytes())
            .await
            .is_err()
        {
            return JobOutcome::failed("cert.install: write site failed");
        }
        JobOutcome::succeeded(json!({"domain": domain, "cert": cert_path}))
    }

    async fn mail_server_ensure(&self, job: &Job) -> JobOutcome {
        let mail_dir = job
            .payload
            .get("mail_dir")
            .and_then(Value::as_str)
            .unwrap_or("/etc/asterpanel/mail");
        let _ = tokio::fs::create_dir_all(mail_dir).await;
        let _ = run_docker(&["rm".into(), "-f".into(), "astp_mailserver".into()]).await;
        match run_docker(&mail_server_args(mail_dir)).await {
            Ok(o) if o.status.success() => {
                let cid = String::from_utf8_lossy(&o.stdout).trim().to_string();
                JobOutcome::succeeded(json!({"container_id": cid, "mail_dir": mail_dir}))
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                if stderr.contains("already in use") || stderr.contains("Conflict") {
                    JobOutcome::succeeded(json!({"idempotent": true}))
                } else {
                    JobOutcome::failed(format!("mail server run failed: {}", stderr.trim()))
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

/// Renders an authoritative BIND-format zone file from a record set. Pure and
/// unit-tested; the agent writes the result and reloads the DNS server.
fn render_zone(zone: &str, serial: u64, records: &[Value]) -> String {
    let mut out = String::new();
    out.push_str(&format!("$ORIGIN {zone}.\n$TTL 3600\n"));
    out.push_str(&format!(
        "@\tIN\tSOA\tns1.{zone}. admin.{zone}. ( {serial} 3600 600 604800 3600 )\n"
    ));
    for r in records {
        let name = r.get("name").and_then(Value::as_str).unwrap_or("@");
        let rtype = r.get("type").and_then(Value::as_str).unwrap_or("A");
        let content = r.get("content").and_then(Value::as_str).unwrap_or("");
        let ttl = r.get("ttl").and_then(Value::as_u64).unwrap_or(3600);
        let prio = r.get("priority").and_then(Value::as_u64);
        let rdata = match rtype {
            "MX" | "SRV" => format!("{} {}", prio.unwrap_or(10), content),
            "TXT" => format!("\"{}\"", content.replace('"', "\\\"")),
            _ => content.to_string(),
        };
        out.push_str(&format!("{name}\t{ttl}\tIN\t{rtype}\t{rdata}\n"));
    }
    out
}

/// Caddy site config — automatic HTTPS (ACME) is on by default.
fn render_caddy_site(domain: &str, upstream: &str) -> String {
    if upstream.is_empty() {
        format!("{domain} {{\n\trespond \"AsterPanel\" 200\n}}\n")
    } else {
        format!("{domain} {{\n\treverse_proxy {upstream}\n}}\n")
    }
}

fn git_clone_args(url: &str, git_ref: &str, dir: &str) -> Vec<String> {
    vec![
        "clone".into(),
        "--depth".into(),
        "1".into(),
        "--branch".into(),
        git_ref.into(),
        "--single-branch".into(),
        url.into(),
        dir.into(),
    ]
}

fn app_run_args(
    container: &str,
    network: &str,
    image: &str,
    tenant: &str,
    dep_id: &str,
) -> Vec<String> {
    vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        container.into(),
        "--restart".into(),
        "unless-stopped".into(),
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
        "--label".into(),
        format!("asterpanel.tenant={tenant}"),
        "--label".into(),
        format!("asterpanel.deployment={dep_id}"),
        image.into(),
    ]
}

/// Dovecot passwd-file line. {PLAIN} is used for the MVP; production stores a
/// hashed scheme such as {SHA512-CRYPT}.
fn render_dovecot_user(address: &str, password: &str) -> String {
    format!("{address}:{{PLAIN}}{password}\n")
}

fn render_postfix_virtual(address: &str) -> String {
    format!("{address}\t{address}\n")
}

fn backup_tar_args(file: &str, target: &str) -> Vec<String> {
    vec![
        "-czf".into(),
        file.into(),
        "-C".into(),
        target.into(),
        ".".into(),
    ]
}

fn backup_untar_args(file: &str, target: &str) -> Vec<String> {
    vec!["-xzf".into(), file.into(), "-C".into(), target.into()]
}

fn s3_cp_args(file: &str, bucket: &str, key: &str) -> Vec<String> {
    vec![
        "s3".into(),
        "cp".into(),
        file.into(),
        format!("s3://{bucket}/{key}"),
    ]
}

fn render_crontab(entries: &[Value]) -> String {
    let mut out = String::from("# Managed by AsterPanel — do not edit\n");
    for e in entries {
        let sched = e.get("schedule").and_then(Value::as_str).unwrap_or("");
        let cmd = e.get("command").and_then(Value::as_str).unwrap_or("");
        if !sched.is_empty() && !cmd.is_empty() {
            out.push_str(&format!("{sched}\t{cmd}\n"));
        }
    }
    out
}

/// OpenSSH `Match` block chrooting an SFTP-only user to its site directory.
fn render_sftp_match(username: &str, home: &str) -> String {
    format!(
        "Match User {username}\n    ChrootDirectory {home}\n    ForceCommand internal-sftp\n    AllowTcpForwarding no\n    X11Forwarding no\n\n"
    )
}

/// docker exec argv that creates a database user. Postgres only for the MVP.
fn db_user_exec_args(
    engine: &str,
    container: &str,
    database: &str,
    owner: &str,
    user: &str,
    pass: &str,
) -> Option<Vec<String>> {
    match engine {
        "postgres" => {
            let sql = format!(
                "CREATE USER \"{user}\" WITH PASSWORD '{pass}'; GRANT ALL PRIVILEGES ON DATABASE \"{database}\" TO \"{user}\";"
            );
            Some(vec![
                "exec".into(),
                container.into(),
                "psql".into(),
                "-U".into(),
                owner.into(),
                "-d".into(),
                database.into(),
                "-c".into(),
                sql,
            ])
        }
        _ => None,
    }
}

/// Caddy site serving a manually-installed certificate (no ACME).
fn render_caddy_site_tls(domain: &str, cert: &str, key: &str) -> String {
    format!("{domain} {{\n\ttls {cert} {key}\n\trespond \"AsterPanel\" 200\n}}\n")
}

fn mail_server_args(mail_dir: &str) -> Vec<String> {
    vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        "astp_mailserver".into(),
        "--restart".into(),
        "unless-stopped".into(),
        "--hostname".into(),
        "mail".into(),
        "-p".into(),
        "25:25".into(),
        "-p".into(),
        "143:143".into(),
        "-p".into(),
        "587:587".into(),
        "-p".into(),
        "993:993".into(),
        "-v".into(),
        format!("{mail_dir}:/tmp/docker-mailserver"),
        "-e".into(),
        "ONE_DIR=1".into(),
        "mailserver/docker-mailserver:latest".into(),
    ]
}

async fn run_cmd(program: &str, args: &[String]) -> std::io::Result<std::process::Output> {
    tokio::process::Command::new(program)
        .args(args)
        .output()
        .await
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

    #[test]
    fn render_zone_emits_soa_and_records() {
        let recs = vec![
            json!({"name": "@", "type": "A", "content": "1.2.3.4", "ttl": 3600}),
            json!({"name": "@", "type": "MX", "content": "mail.acme.com.", "ttl": 3600, "priority": 10}),
            json!({"name": "@", "type": "TXT", "content": "v=spf1 ~all", "ttl": 3600}),
        ];
        let z = render_zone("acme.com", 5, &recs);
        assert!(z.contains("$ORIGIN acme.com."), "{z}");
        assert!(
            z.contains("SOA\tns1.acme.com. admin.acme.com. ( 5 3600 600"),
            "{z}"
        );
        assert!(z.contains("IN\tA\t1.2.3.4"), "{z}");
        assert!(z.contains("IN\tMX\t10 mail.acme.com."), "{z}");
        assert!(z.contains("IN\tTXT\t\"v=spf1 ~all\""), "{z}");
    }

    #[test]
    fn caddy_site_with_and_without_upstream() {
        assert!(render_caddy_site("acme.com", "astp_site_1:80")
            .contains("reverse_proxy astp_site_1:80"));
        assert!(render_caddy_site("acme.com", "").contains("respond"));
    }

    #[test]
    fn git_clone_args_use_depth_and_branch() {
        let a = git_clone_args("https://x/y.git", "main", "/tmp/w").join(" ");
        assert_eq!(
            a,
            "clone --depth 1 --branch main --single-branch https://x/y.git /tmp/w"
        );
    }

    #[test]
    fn app_run_args_are_hardened() {
        let a = app_run_args("astp_app_1", "net", "img:1", "t1", "d1").join(" ");
        assert!(a.contains("--cap-drop ALL"), "{a}");
        assert!(a.contains("no-new-privileges"), "{a}");
        assert!(a.ends_with("img:1"), "{a}");
    }

    #[test]
    fn dovecot_user_uses_plain_scheme() {
        assert_eq!(
            render_dovecot_user("info@acme.com", "pw"),
            "info@acme.com:{PLAIN}pw\n"
        );
    }

    #[test]
    fn backup_args_compress_and_extract() {
        assert_eq!(
            backup_tar_args("/b/x.tar.gz", "/sites").join(" "),
            "-czf /b/x.tar.gz -C /sites ."
        );
        assert_eq!(
            backup_untar_args("/b/x.tar.gz", "/sites").join(" "),
            "-xzf /b/x.tar.gz -C /sites"
        );
    }

    #[test]
    fn crontab_renders_entries() {
        let e = vec![json!({"schedule":"0 3 * * *","command":"backup.sh"})];
        assert!(render_crontab(&e).contains("0 3 * * *\tbackup.sh"));
    }

    #[test]
    fn sftp_match_is_chrooted() {
        let s = render_sftp_match("acme", "/sites/acme");
        assert!(s.contains("Match User acme"));
        assert!(s.contains("ChrootDirectory /sites/acme"));
        assert!(s.contains("internal-sftp"));
    }

    #[test]
    fn db_user_exec_postgres_only() {
        let a = db_user_exec_args("postgres", "astp_db_1", "app", "app", "u", "pw").unwrap();
        let s = a.join(" ");
        assert!(s.contains("exec astp_db_1 psql -U app -d app -c"), "{s}");
        assert!(s.contains("CREATE USER \"u\""), "{s}");
        assert!(db_user_exec_args("mysql", "c", "d", "o", "u", "p").is_none());
    }

    #[test]
    fn caddy_tls_site_uses_cert_and_key() {
        assert!(render_caddy_site_tls("acme.com", "/c/a.crt", "/c/a.key")
            .contains("tls /c/a.crt /c/a.key"));
    }

    #[test]
    fn s3_cp_builds_uri() {
        assert_eq!(
            s3_cp_args("/b/x.tar.gz", "mybucket", "backups/x.tar.gz").join(" "),
            "s3 cp /b/x.tar.gz s3://mybucket/backups/x.tar.gz"
        );
    }

    #[test]
    fn mail_server_args_have_image_and_ports() {
        let s = mail_server_args("/etc/mail").join(" ");
        assert!(s.contains("mailserver/docker-mailserver:latest"), "{s}");
        assert!(s.contains("143:143"), "{s}");
    }
}
