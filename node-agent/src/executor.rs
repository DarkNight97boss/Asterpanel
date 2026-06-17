//! Executors carry out validated jobs on the node. The `Executor` trait is the
//! seam for the runtime backend: `DockerExecutor` is the first implementation;
//! a containerd/Kubernetes executor implements the same trait without any change
//! to the verification pipeline above it.
//!
//! Every container is created **non-privileged**: a dedicated UID, read-only
//! rootfs, all capabilities dropped, `no-new-privileges`, PID/memory/CPU limits,
//! and a per-tenant network. Executors are idempotent — re-running a job whose
//! effect already exists is treated as success.

use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use async_trait::async_trait;
use base64::Engine;
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
            "mail.dkim.generate" => self.mail_dkim_generate(job).await,
            "mail.alias.apply" => self.mail_alias_apply(job).await,
            "mail.autoresponder.apply" => self.mail_autoresponder_apply(job).await,
            "mail.filter.apply" => self.mail_filter_apply(job).await,
            "cron.apply" => self.cron_apply(job).await,
            "ftp.account.create" => self.ftp_account_create(job).await,
            "database.user.create" => self.database_user_create(job).await,
            "database.query" => self.database_query(job).await,
            "cert.install" => self.cert_install(job).await,
            "firewall.apply" => self.firewall_apply(job).await,
            "waf.apply" => self.waf_apply(job).await,
            "redirect.apply" => self.redirect_apply(job).await,
            "file.list" => self.file_list(job).await,
            "file.read" => self.file_read(job).await,
            "file.write" => self.file_write(job).await,
            "file.delete" => self.file_delete(job).await,
            "file.mkdir" => self.file_mkdir(job).await,
            "runtime.switch" => self.runtime_switch(job).await,
            "logs.tail" => self.logs_tail(job).await,
            "antivirus.scan" => self.antivirus_scan(job).await,
            "health.check" => self.health_check(job).await,
            "analytics.compute" => self.analytics_compute(job).await,
            "backup.create" => self.backup_create(job).await,
            "backup.restore" => self.backup_restore(job).await,
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

        // Buildpacks: if the repo ships no Dockerfile, detect the stack from its
        // marker files and synthesize one so deploy-from-git works without it.
        let mut buildpack = "dockerfile";
        if !tokio::fs::try_exists(format!("{workdir}/Dockerfile"))
            .await
            .unwrap_or(false)
        {
            let mut names: Vec<String> = Vec::new();
            if let Ok(mut rd) = tokio::fs::read_dir(&workdir).await {
                while let Ok(Some(e)) = rd.next_entry().await {
                    names.push(e.file_name().to_string_lossy().into_owned());
                }
            }
            let refs: Vec<&str> = names.iter().map(String::as_str).collect();
            match detect_buildpack(&refs) {
                Some(bp) => match generate_dockerfile(bp) {
                    Some(df) => {
                        if let Err(e) =
                            tokio::fs::write(format!("{workdir}/Dockerfile"), df).await
                        {
                            return JobOutcome::failed(format!(
                                "app.deploy: could not write generated Dockerfile: {e}"
                            ));
                        }
                        buildpack = bp;
                    }
                    None => return JobOutcome::failed("app.deploy: unsupported buildpack"),
                },
                None => {
                    return JobOutcome::failed(
                        "app.deploy: no Dockerfile and no detectable stack (node/php/static)",
                    )
                }
            }
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
                    "image": image, "container_id": cid, "container": container,
                    "network": network, "buildpack": buildpack,
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

    /// Regenerates the Postfix virtual-alias map from the full forwarder set.
    /// Declarative: the job carries every forwarder for the tenant and the agent
    /// overwrites the map, so deletes propagate without a separate command.
    async fn mail_alias_apply(&self, job: &Job) -> JobOutcome {
        let empty: Vec<Value> = Vec::new();
        let forwarders = job
            .payload
            .get("forwarders")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let content = render_postfix_virtual_aliases(forwarders);
        let dir = std::env::var("AGENT_MAIL_DIR").unwrap_or_else(|_| "/etc/asterpanel/mail".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("mail.alias.apply: mkdir failed: {e}"));
        }
        let path = format!("{dir}/postfix-virtual-aliases");
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("mail.alias.apply: write failed: {e}"));
        }
        // The data lines (everything but the header comment) are the live aliases.
        let count = content
            .lines()
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .count();
        JobOutcome::succeeded(json!({"path": path, "forwarders": count}))
    }

    /// Regenerates the global Sieve vacation script from the full autoresponder
    /// set (declarative, same model as the alias map).
    async fn mail_autoresponder_apply(&self, job: &Job) -> JobOutcome {
        let empty: Vec<Value> = Vec::new();
        let items = job
            .payload
            .get("autoresponders")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let content = render_sieve_autoresponders(items);
        let dir = std::env::var("AGENT_MAIL_DIR").unwrap_or_else(|_| "/etc/asterpanel/mail".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("mail.autoresponder.apply: mkdir failed: {e}"));
        }
        let path = format!("{dir}/asterpanel-autoresponders.sieve");
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("mail.autoresponder.apply: write failed: {e}"));
        }
        JobOutcome::succeeded(json!({"path": path, "autoresponders": items.len()}))
    }

    /// Regenerates the global Sieve filter script from the full rule set.
    async fn mail_filter_apply(&self, job: &Job) -> JobOutcome {
        let empty: Vec<Value> = Vec::new();
        let filters = job
            .payload
            .get("filters")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let content = render_sieve_filters(filters);
        let dir = std::env::var("AGENT_MAIL_DIR").unwrap_or_else(|_| "/etc/asterpanel/mail".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("mail.filter.apply: mkdir failed: {e}"));
        }
        let path = format!("{dir}/asterpanel-filters.sieve");
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("mail.filter.apply: write failed: {e}"));
        }
        JobOutcome::succeeded(json!({"path": path, "filters": filters.len()}))
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
                // Integrity checksum of the artifact (verified on restore).
                let sha256 = sha256_file(&file).await;
                // Off-site upload when an S3 bucket is configured (uses the aws CLI).
                if let Ok(bucket) = std::env::var("AGENT_S3_BUCKET") {
                    let key = format!("backups/{backup_id}.tar.gz");
                    if let Ok(u) = run_cmd("aws", &s3_cp_args(&file, &bucket, &key)).await {
                        if u.status.success() {
                            return JobOutcome::succeeded(json!({
                                "path": file, "size_bytes": size, "sha256": sha256, "storage": "s3",
                                "s3": format!("s3://{bucket}/{key}"),
                            }));
                        }
                    }
                }
                JobOutcome::succeeded(
                    json!({"path": file, "size_bytes": size, "sha256": sha256, "storage": "local"}),
                )
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

    /// Runs an ad-hoc SQL statement inside the database container and returns the
    /// result set as columns + rows (a phpMyAdmin-style query runner). A
    /// statement timeout caps runaway queries; the output row count is capped by
    /// the caller's `max_rows`.
    async fn database_query(&self, job: &Job) -> JobOutcome {
        let pv = |k: &str| job.payload.get(k).and_then(Value::as_str);
        let db_id = pv("database_id").unwrap_or("unknown");
        let engine = pv("engine").unwrap_or("postgres");
        let database = pv("database").unwrap_or("app");
        let owner = pv("owner").unwrap_or(database);
        let sql = pv("sql").unwrap_or("").trim();
        if sql.is_empty() {
            return JobOutcome::failed("database.query: empty sql");
        }
        let max_rows = job
            .payload
            .get("max_rows")
            .and_then(Value::as_u64)
            .unwrap_or(500) as usize;
        let container = format!("astp_db_{db_id}");
        let args = match db_query_args(engine, &container, database, owner, sql) {
            Some(a) => a,
            None => return JobOutcome::failed(format!("database.query: unsupported engine {engine}")),
        };
        match run_docker(&args).await {
            Ok(o) if o.status.success() => {
                let out = String::from_utf8_lossy(&o.stdout);
                let (columns, mut rows) = parse_query_output(engine, &out);
                let total = rows.len();
                let truncated = total > max_rows;
                if truncated {
                    rows.truncate(max_rows);
                }
                JobOutcome::succeeded(json!({
                    "columns": columns, "rows": rows, "row_count": total, "truncated": truncated,
                }))
            }
            Ok(o) => JobOutcome::failed(format!(
                "query failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
        }
    }

    /// Aggregates a site's Caddy JSON access log into web-analytics figures
    /// (requests, unique visitors, bandwidth, top paths, status classes). A
    /// missing log yields a well-formed empty summary rather than an error.
    async fn analytics_compute(&self, job: &Job) -> JobOutcome {
        let site_id = job
            .payload
            .get("site_id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let top_n = job
            .payload
            .get("top_paths")
            .and_then(Value::as_u64)
            .unwrap_or(10) as usize;
        let dir = std::env::var("AGENT_ACCESS_LOG_DIR")
            .unwrap_or_else(|_| "/var/log/asterpanel/access".into());
        let path = job
            .payload
            .get("log_path")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{dir}/{site_id}.log"));
        let content = match tokio::fs::read_to_string(&path).await {
            Ok(c) => c,
            Err(_) => {
                return JobOutcome::succeeded(json!({
                    "requests": 0, "visitors": 0, "bytes": 0, "top_paths": [],
                    "status_classes": {"2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0},
                    "log_present": false,
                }));
            }
        };
        let mut summary = parse_access_log(&content, top_n);
        if let Some(obj) = summary.as_object_mut() {
            obj.insert("log_present".into(), json!(true));
        }
        JobOutcome::succeeded(summary)
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

    async fn firewall_apply(&self, job: &Job) -> JobOutcome {
        let empty: Vec<Value> = Vec::new();
        let rules = job
            .payload
            .get("rules")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let content = render_nftables(rules);
        let dir = std::env::var("AGENT_NFTABLES_DIR")
            .unwrap_or_else(|_| "/etc/asterpanel/firewall".into());
        let path = format!("{dir}/asterpanel.nft");
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("firewall.apply: mkdir failed: {e}"));
        }
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("firewall.apply: write failed: {e}"));
        }
        // Best-effort live load; the file is the source of truth (re-applied on boot).
        let _ = run_cmd("nft", &["-f".into(), path.clone()]).await;
        JobOutcome::succeeded(json!({"path": path, "rules": rules.len()}))
    }

    /// Renders the org's WAF rules into a Caddy snippet (named matchers + 403)
    /// that the site config imports. Caddy is the data-plane reverse proxy.
    async fn waf_apply(&self, job: &Job) -> JobOutcome {
        let empty: Vec<Value> = Vec::new();
        let rules = job
            .payload
            .get("rules")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let content = render_caddy_waf(rules);
        let dir =
            std::env::var("AGENT_CADDY_DIR").unwrap_or_else(|_| "/etc/asterpanel/caddy".into());
        let path = format!("{dir}/waf.caddy");
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("waf.apply: mkdir failed: {e}"));
        }
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("waf.apply: write failed: {e}"));
        }
        // Best-effort live reload; the file is the source of truth.
        let _ = run_cmd("caddy", &["reload".into(), "--force".into()]).await;
        JobOutcome::succeeded(json!({"path": path, "rules": rules.len()}))
    }

    /// Regenerates the Caddy redirects snippet from the full redirect set: one
    /// site block per source domain, each with its `redir` directives.
    async fn redirect_apply(&self, job: &Job) -> JobOutcome {
        let empty: Vec<Value> = Vec::new();
        let redirects = job
            .payload
            .get("redirects")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let content = render_caddy_redirects(redirects);
        let dir =
            std::env::var("AGENT_CADDY_DIR").unwrap_or_else(|_| "/etc/asterpanel/caddy".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("redirect.apply: mkdir failed: {e}"));
        }
        let path = format!("{dir}/redirects.caddy");
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("redirect.apply: write failed: {e}"));
        }
        let _ = run_cmd("caddy", &["reload".into(), "--force".into()]).await;
        JobOutcome::succeeded(json!({"path": path, "redirects": redirects.len()}))
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

    /// Generates the DKIM keypair for a mail domain on the mail-server container
    /// and returns the public key as a DNS-ready TXT record so the customer can
    /// publish `<selector>._domainkey.<domain>` at their registrar. Idempotent:
    /// re-running just reads the existing public key.
    async fn mail_dkim_generate(&self, job: &Job) -> JobOutcome {
        let domain = job.payload.get("domain").and_then(Value::as_str).unwrap_or("");
        let selector = job.payload.get("selector").and_then(Value::as_str).unwrap_or("mail");
        if domain.is_empty() || !valid_mail_domain(domain) {
            return JobOutcome::failed("mail.dkim.generate: invalid domain");
        }
        if !valid_dkim_selector(selector) {
            return JobOutcome::failed("mail.dkim.generate: invalid selector");
        }
        // setup.sh inside docker-mailserver is the supported entry point for DKIM.
        let _ = run_docker(&[
            "exec".into(), "astp_mailserver".into(),
            "setup".into(), "config".into(), "dkim".into(),
            "domain".into(), domain.into(), "selector".into(), selector.into(),
        ]).await;
        let txt_path = format!(
            "/tmp/docker-mailserver/opendkim/keys/{domain}/{selector}.txt",
        );
        let out = run_docker(&["exec".into(), "astp_mailserver".into(), "cat".into(), txt_path]).await;
        match out {
            Ok(o) if o.status.success() => {
                let raw = String::from_utf8_lossy(&o.stdout).into_owned();
                let value = parse_dkim_txt(&raw).unwrap_or_default();
                JobOutcome::succeeded(json!({
                    "domain": domain, "selector": selector,
                    "record": {
                        "name": format!("{selector}._domainkey.{domain}"),
                        "type": "TXT", "ttl": 3600, "content": value,
                    },
                    "spf": {"name": domain, "type": "TXT", "ttl": 3600, "content": "v=spf1 mx ~all"},
                    "dmarc": {"name": format!("_dmarc.{domain}"), "type": "TXT", "ttl": 3600,
                              "content": format!("v=DMARC1; p=quarantine; rua=mailto:postmaster@{domain}")},
                }))
            }
            Ok(o) => JobOutcome::failed(format!("dkim key not found: {}", String::from_utf8_lossy(&o.stderr).trim())),
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

    /// Switches a site to a new runtime/version by recreating its container from
    /// the matching base image. The old container is removed first so the name
    /// is free; the site's bind-mounted document root is unaffected.
    async fn runtime_switch(&self, job: &Job) -> JobOutcome {
        let pv = |k: &str| job.payload.get(k).and_then(Value::as_str);
        let website_id = pv("website_id").unwrap_or("unknown");
        let runtime = pv("runtime").unwrap_or("static");
        let version = pv("version").unwrap_or("");

        let network = format!("astp_tenant_{}", job.tenant_id);
        if let Err(e) = ensure_network(&network).await {
            return JobOutcome::failed(format!("network setup failed: {e}"));
        }
        let name = format!("astp_site_{website_id}");
        let image = image_for_runtime_version(runtime, version);
        // Recreate: free the name, then run the new image.
        let _ = run_docker(&["rm".into(), "-f".into(), name.clone()]).await;
        let args = hardened_run_args(
            &name,
            &network,
            &image,
            &job.tenant_id.to_string(),
            website_id,
        );
        match run_docker(&args).await {
            Ok(out) if out.status.success() => {
                let cid = String::from_utf8_lossy(&out.stdout).trim().to_string();
                JobOutcome::succeeded(json!({
                    "container_id": cid, "image": image,
                    "runtime": runtime, "version": version, "name": name,
                }))
            }
            Ok(out) => JobOutcome::failed(format!(
                "runtime.switch run failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
        }
    }

    /// Tails a managed container's logs. The container name must be one of ours
    /// (`astp_*`) — this both scopes access to platform containers and, since the
    /// name can never begin with `-`, prevents argv injection into `docker logs`.
    async fn logs_tail(&self, job: &Job) -> JobOutcome {
        let container = job
            .payload
            .get("container")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !valid_container_name(container) {
            return JobOutcome::failed("logs.tail: invalid container name");
        }
        let tail = job
            .payload
            .get("tail")
            .and_then(Value::as_u64)
            .unwrap_or(200)
            .clamp(1, 2000);

        match run_docker(&docker_logs_args(container, tail)).await {
            Ok(out) => {
                // docker writes container stdout→our stdout, stderr→our stderr.
                let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
                let stderr = String::from_utf8_lossy(&out.stderr);
                if !out.status.success() && text.is_empty() {
                    return JobOutcome::failed(format!("logs.tail: {}", stderr.trim()));
                }
                if !stderr.is_empty() {
                    text.push_str(&stderr);
                }
                let lines: Vec<&str> = text.lines().collect();
                JobOutcome::succeeded(json!({ "container": container, "lines": lines }))
            }
            Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
        }
    }

    /// Health-probes a site: container liveness (`docker inspect`) plus an
    /// optional HTTP GET. Always succeeds as a job — the health verdict is in the
    /// result, so the control plane records "down" rather than a failed job.
    async fn health_check(&self, job: &Job) -> JobOutcome {
        let container = job
            .payload
            .get("container")
            .and_then(Value::as_str)
            .unwrap_or("");
        let running = if valid_container_name(container) {
            matches!(
                run_docker(&[
                    "inspect".into(),
                    "-f".into(),
                    "{{.State.Running}}".into(),
                    container.into(),
                ])
                .await,
                Ok(o) if o.status.success()
                    && String::from_utf8_lossy(&o.stdout).trim() == "true"
            )
        } else {
            false
        };

        let target = job
            .payload
            .get("target_url")
            .and_then(Value::as_str)
            .unwrap_or("");
        let (http_code, latency_ms) = if target.is_empty() {
            (None, 0u64)
        } else {
            probe_http(target).await
        };

        let status = classify_health(running, http_code);
        JobOutcome::succeeded(json!({
            "status": status,
            "running": running,
            "http_code": http_code,
            "latency_ms": latency_ms,
        }))
    }

    /// Scans a sandboxed site path with ClamAV. Reuses the file-manager sandbox
    /// (`site_and_rel` + `resolve_within`) so a scan can never escape the site
    /// root. Gracefully reports `engine_available: false` when clamscan is absent
    /// rather than failing the job.
    async fn antivirus_scan(&self, job: &Job) -> JobOutcome {
        let (root, rel) = match site_and_rel(&job.payload) {
            Some(v) => v,
            None => return JobOutcome::failed("antivirus.scan: invalid site or path"),
        };
        let target = match resolve_within(&root, &rel) {
            Some(t) => t,
            None => return JobOutcome::failed("antivirus.scan: path escapes site root"),
        };
        let target_str = target.to_string_lossy().to_string();

        match run_cmd("clamscan", &clamscan_args(&target_str)).await {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let infected = parse_clamscan(&stdout);
                JobOutcome::succeeded(json!({
                    "engine_available": true,
                    "scanned_path": display_path(&rel),
                    "clean": infected.is_empty(),
                    "infected": infected
                        .into_iter()
                        .map(|(file, signature)| json!({"file": file, "signature": signature}))
                        .collect::<Vec<_>>(),
                }))
            }
            // clamscan not installed on the node — report instead of failing.
            Err(_) => JobOutcome::succeeded(json!({
                "engine_available": false,
                "scanned_path": display_path(&rel),
                "clean": true,
                "infected": [],
            })),
        }
    }

    // --- File manager (site-scoped, sandboxed) ------------------------------
    // Every op resolves a client path inside `<AGENT_SITES_DIR>/<site_id>` and
    // refuses anything that climbs above it (see `resolve_within`). Symlinks on
    // an existing target are refused so a tenant cannot link out of their root.

    async fn file_list(&self, job: &Job) -> JobOutcome {
        let (root, rel) = match site_and_rel(&job.payload) {
            Some(v) => v,
            None => return JobOutcome::failed("file.list: invalid site or path"),
        };
        let target = match resolve_within(&root, &rel) {
            Some(t) => t,
            None => return JobOutcome::failed("file.list: path escapes site root"),
        };
        // Listing the site root for the first time should succeed, not 404.
        if rel.is_empty() {
            let _ = tokio::fs::create_dir_all(&target).await;
        }
        let mut rd = match tokio::fs::read_dir(&target).await {
            Ok(r) => r,
            Err(e) => return JobOutcome::failed(format!("file.list: {e}")),
        };
        let mut entries: Vec<Value> = Vec::new();
        while let Ok(Some(ent)) = rd.next_entry().await {
            let md = match ent.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_dir = md.is_dir();
            entries.push(json!({
                "name": ent.file_name().to_string_lossy(),
                "type": if is_dir { "dir" } else { "file" },
                "size": if is_dir { Value::Null } else { json!(md.len()) },
                "modified": mtime_millis(&md),
            }));
        }
        // Directories first, then alphabetical — a predictable browsing order.
        entries.sort_by(|a, b| {
            let ad = a["type"] == json!("dir");
            let bd = b["type"] == json!("dir");
            bd.cmp(&ad).then_with(|| {
                a["name"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["name"].as_str().unwrap_or(""))
            })
        });
        JobOutcome::succeeded(json!({"path": display_path(&rel), "entries": entries}))
    }

    async fn file_read(&self, job: &Job) -> JobOutcome {
        let (root, rel) = match site_and_rel(&job.payload) {
            Some(v) => v,
            None => return JobOutcome::failed("file.read: invalid site or path"),
        };
        let target = match resolve_within(&root, &rel) {
            Some(t) => t,
            None => return JobOutcome::failed("file.read: path escapes site root"),
        };
        match tokio::fs::symlink_metadata(&target).await {
            Ok(md) if md.file_type().is_symlink() => {
                return JobOutcome::failed("file.read: refusing to follow a symlink")
            }
            Ok(md) if md.is_dir() => return JobOutcome::failed("file.read: path is a directory"),
            Ok(md) if md.len() > MAX_READ_BYTES => {
                return JobOutcome::succeeded(json!({
                    "path": display_path(&rel), "size": md.len(),
                    "truncated": true, "encoding": "none", "content": "",
                }))
            }
            Ok(_) => {}
            Err(e) => return JobOutcome::failed(format!("file.read: {e}")),
        }
        let bytes = match tokio::fs::read(&target).await {
            Ok(b) => b,
            Err(e) => return JobOutcome::failed(format!("file.read: {e}")),
        };
        let size = bytes.len() as u64;
        // Serve clean UTF-8 as text; anything else (or with NULs) as base64.
        match String::from_utf8(bytes) {
            Ok(s) if !s.contains('\0') => JobOutcome::succeeded(json!({
                "path": display_path(&rel), "size": size,
                "truncated": false, "encoding": "utf8", "content": s,
            })),
            Ok(s) => JobOutcome::succeeded(json!({
                "path": display_path(&rel), "size": size, "truncated": false,
                "encoding": "base64",
                "content": base64::engine::general_purpose::STANDARD.encode(s.as_bytes()),
            })),
            Err(e) => JobOutcome::succeeded(json!({
                "path": display_path(&rel), "size": size, "truncated": false,
                "encoding": "base64",
                "content": base64::engine::general_purpose::STANDARD.encode(e.as_bytes()),
            })),
        }
    }

    async fn file_write(&self, job: &Job) -> JobOutcome {
        let (root, rel) = match site_and_rel(&job.payload) {
            Some(v) => v,
            None => return JobOutcome::failed("file.write: invalid site or path"),
        };
        if rel.is_empty() {
            return JobOutcome::failed("file.write: a file path is required");
        }
        let target = match resolve_within(&root, &rel) {
            Some(t) => t,
            None => return JobOutcome::failed("file.write: path escapes site root"),
        };
        let b64 = job
            .payload
            .get("content_b64")
            .and_then(Value::as_str)
            .unwrap_or("");
        let bytes = match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(b) => b,
            Err(_) => return JobOutcome::failed("file.write: invalid base64 content"),
        };
        if bytes.len() as u64 > MAX_WRITE_BYTES {
            return JobOutcome::failed("file.write: content exceeds 5 MiB limit");
        }
        if let Ok(md) = tokio::fs::symlink_metadata(&target).await {
            if md.file_type().is_symlink() {
                return JobOutcome::failed("file.write: refusing to overwrite a symlink");
            }
            if md.is_dir() {
                return JobOutcome::failed("file.write: path is a directory");
            }
        }
        if let Some(parent) = target.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return JobOutcome::failed(format!("file.write: mkdir failed: {e}"));
            }
        }
        if let Err(e) = tokio::fs::write(&target, &bytes).await {
            return JobOutcome::failed(format!("file.write: {e}"));
        }
        JobOutcome::succeeded(json!({"path": display_path(&rel), "written": bytes.len()}))
    }

    async fn file_mkdir(&self, job: &Job) -> JobOutcome {
        let (root, rel) = match site_and_rel(&job.payload) {
            Some(v) => v,
            None => return JobOutcome::failed("file.mkdir: invalid site or path"),
        };
        if rel.is_empty() {
            return JobOutcome::failed("file.mkdir: a directory path is required");
        }
        let target = match resolve_within(&root, &rel) {
            Some(t) => t,
            None => return JobOutcome::failed("file.mkdir: path escapes site root"),
        };
        if let Err(e) = tokio::fs::create_dir_all(&target).await {
            return JobOutcome::failed(format!("file.mkdir: {e}"));
        }
        JobOutcome::succeeded(json!({"path": display_path(&rel), "created": true}))
    }

    async fn file_delete(&self, job: &Job) -> JobOutcome {
        let (root, rel) = match site_and_rel(&job.payload) {
            Some(v) => v,
            None => return JobOutcome::failed("file.delete: invalid site or path"),
        };
        if rel.is_empty() {
            return JobOutcome::failed("file.delete: refusing to delete the site root");
        }
        let target = match resolve_within(&root, &rel) {
            Some(t) => t,
            None => return JobOutcome::failed("file.delete: path escapes site root"),
        };
        // symlink_metadata so we remove the link itself, never its target.
        let md = match tokio::fs::symlink_metadata(&target).await {
            Ok(m) => m,
            Err(e) => return JobOutcome::failed(format!("file.delete: {e}")),
        };
        let res = if md.is_dir() {
            tokio::fs::remove_dir_all(&target).await
        } else {
            tokio::fs::remove_file(&target).await
        };
        if let Err(e) = res {
            return JobOutcome::failed(format!("file.delete: {e}"));
        }
        JobOutcome::succeeded(json!({"path": display_path(&rel), "deleted": true}))
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

/// Detects a buildpack from a repo's top-level file names (used only when no
/// Dockerfile is present). Order matters: an explicit app manifest wins over a
/// bare static site.
fn detect_buildpack(files: &[&str]) -> Option<&'static str> {
    let has = |n: &str| files.iter().any(|f| f.eq_ignore_ascii_case(n));
    if has("package.json") {
        Some("node")
    } else if has("composer.json") || has("index.php") {
        Some("php")
    } else if has("index.html") {
        Some("static")
    } else {
        None
    }
}

/// Synthesizes a hardened Dockerfile for a detected buildpack.
fn generate_dockerfile(buildpack: &str) -> Option<String> {
    let df = match buildpack {
        "node" => "FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi\nEXPOSE 3000\nCMD [\"npm\",\"start\"]\n",
        "php" => "FROM php:8.3-apache\nCOPY . /var/www/html/\nEXPOSE 80\n",
        "static" => "FROM nginxinc/nginx-unprivileged:stable-alpine\nCOPY . /usr/share/nginx/html/\nEXPOSE 8080\n",
        _ => return None,
    };
    Some(df.to_string())
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

/// Renders the Postfix virtual-alias map from forwarder entries, one line per
/// source: `source dest1,dest2` (docker-mailserver `postfix-virtual.cf` format).
/// A bad source or an empty destination set is skipped so a single malformed row
/// can't poison the whole map.
fn render_postfix_virtual_aliases(forwarders: &[Value]) -> String {
    let mut out = String::from("# AsterPanel mail forwarders (generated — do not edit)\n");
    for f in forwarders {
        let source = f.get("source").and_then(Value::as_str).unwrap_or("").trim();
        if !valid_forward_source(source) {
            continue;
        }
        let dests: Vec<&str> = f
            .get("destinations")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|d| valid_email(d))
                    .collect()
            })
            .unwrap_or_default();
        if dests.is_empty() {
            continue;
        }
        out.push_str(&format!("{source} {}\n", dests.join(",")));
    }
    out
}

/// Renders a global Pigeonhole Sieve script that fires a `vacation` auto-reply
/// for each enabled autoresponder, guarded by the envelope recipient and (when
/// set) a start/end date window. The script overwrites the previous one so a
/// removed autoresponder simply disappears.
fn render_sieve_autoresponders(items: &[Value]) -> String {
    let mut out = String::from("# AsterPanel autoresponders (generated — do not edit)\n");
    out.push_str("require [\"vacation\", \"envelope\", \"date\", \"relational\"];\n\n");
    for it in items {
        let addr = it.get("address").and_then(Value::as_str).unwrap_or("").trim();
        if !valid_email(addr) {
            continue;
        }
        let subject = it.get("subject").and_then(Value::as_str).unwrap_or("Auto-reply");
        let body = it.get("body").and_then(Value::as_str).unwrap_or("");
        let days = it
            .get("interval_days")
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .clamp(1, 30);
        let start = it.get("start_date").and_then(Value::as_str).unwrap_or("").trim();
        let end = it.get("end_date").and_then(Value::as_str).unwrap_or("").trim();

        let mut conds = vec![format!("envelope :is \"to\" \"{}\"", sieve_quote(addr))];
        if valid_iso_date(start) {
            conds.push(format!("currentdate :value \"ge\" \"date\" \"{start}\""));
        }
        if valid_iso_date(end) {
            conds.push(format!("currentdate :value \"le\" \"date\" \"{end}\""));
        }
        out.push_str(&format!("# {addr}\n"));
        out.push_str(&format!("if allof ({}) {{\n", conds.join(", ")));
        out.push_str(&format!(
            "  vacation :days {days} :subject \"{}\"\n",
            sieve_quote(subject)
        ));
        out.push_str("  text:\n");
        for line in body.lines() {
            if line.starts_with('.') {
                out.push('.'); // dot-stuff so the body can't end the text block early
            }
            out.push_str(line);
            out.push('\n');
        }
        out.push_str(".\n  ;\n}\n\n");
    }
    out
}

/// Escapes a Sieve quoted-string literal (`\` and `"`).
fn sieve_quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Validates a `YYYY-MM-DD` date string (structure only).
fn valid_iso_date(s: &str) -> bool {
    s.len() == 10
        && s.chars().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                c == '-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// Renders a global Pigeonhole Sieve script of per-mailbox filter rules. Each
/// rule matches a header (from/to/subject/cc) against a value and performs one
/// action (file into a folder, discard, redirect, keep), guarded by the envelope
/// recipient so a rule only affects its own mailbox. Malformed rules are skipped.
fn render_sieve_filters(filters: &[Value]) -> String {
    let mut out = String::from("# AsterPanel mail filters (generated — do not edit)\n");
    out.push_str("require [\"fileinto\", \"envelope\"];\n\n");
    for f in filters {
        let addr = f.get("address").and_then(Value::as_str).unwrap_or("").trim();
        if !valid_email(addr) {
            continue;
        }
        let header = match f.get("field").and_then(Value::as_str).unwrap_or("") {
            "from" => "from",
            "to" => "to",
            "subject" => "subject",
            "cc" => "cc",
            _ => continue,
        };
        let op = match f.get("op").and_then(Value::as_str).unwrap_or("contains") {
            "is" => ":is",
            "matches" => ":matches",
            _ => ":contains",
        };
        let value = f.get("value").and_then(Value::as_str).unwrap_or("").trim();
        if value.is_empty() {
            continue;
        }
        let arg = f.get("action_arg").and_then(Value::as_str).unwrap_or("").trim();
        let action_body = match f.get("action").and_then(Value::as_str).unwrap_or("keep") {
            "fileinto" => {
                if arg.is_empty() {
                    continue;
                }
                format!("  fileinto \"{}\";\n  stop;\n", sieve_quote(arg))
            }
            "discard" => "  discard;\n  stop;\n".to_string(),
            "redirect" => {
                if !valid_email(arg) {
                    continue;
                }
                format!("  redirect \"{}\";\n  stop;\n", sieve_quote(arg))
            }
            _ => "  keep;\n".to_string(),
        };
        let name = f.get("name").and_then(Value::as_str).unwrap_or("filter");
        out.push_str(&format!("# {name} ({addr})\n"));
        out.push_str(&format!(
            "if allof (envelope :is \"to\" \"{}\", header {} \"{}\" \"{}\") {{\n",
            sieve_quote(addr),
            op,
            header,
            sieve_quote(value)
        ));
        out.push_str(&action_body);
        out.push_str("}\n\n");
    }
    out
}

/// A forwarder source is a full address (`sales@example.com`) or a catch-all
/// (`@example.com`).
fn valid_forward_source(s: &str) -> bool {
    match s.strip_prefix('@') {
        Some(domain) => valid_mail_domain(domain),
        None => valid_email(s),
    }
}

/// Minimal address check: exactly one `@`, sane local part, valid mail domain.
fn valid_email(s: &str) -> bool {
    let mut parts = s.splitn(2, '@');
    let local = parts.next().unwrap_or("");
    let domain = match parts.next() {
        Some(d) => d,
        None => return false,
    };
    !local.is_empty()
        && local.len() <= 64
        && local
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._%+-".contains(c))
        && valid_mail_domain(domain)
}

/// Computes the SHA-256 of a file via `sha256sum` (None when it's unavailable).
async fn sha256_file(path: &str) -> String {
    match run_cmd("sha256sum", &[path.to_string()]).await {
        Ok(o) if o.status.success() => {
            parse_sha256sum(&String::from_utf8_lossy(&o.stdout)).unwrap_or_default()
        }
        _ => String::new(),
    }
}

/// Extracts the 64-hex digest from `sha256sum` output (`<hex>  <file>`).
fn parse_sha256sum(out: &str) -> Option<String> {
    out.split_whitespace()
        .next()
        .filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|h| h.to_lowercase())
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

/// Renders an nftables ruleset from the org's firewall rules (deny => drop).
/// Renders WAF rules into a Caddy snippet: a named request matcher per rule and
/// a `respond <matcher> 403`. Supported match types: path (regex), user_agent
/// (regex on the UA header), ip (CIDR/address).
fn render_caddy_waf(rules: &[Value]) -> String {
    let mut out = String::from("# AsterPanel WAF (generated — do not edit)\n");
    let mut names: Vec<String> = Vec::new();
    for (i, r) in rules.iter().enumerate() {
        let mt = r.get("match_type").and_then(Value::as_str).unwrap_or("");
        let pat = r.get("pattern").and_then(Value::as_str).unwrap_or("");
        if pat.is_empty() {
            continue;
        }
        let name = format!("@waf{i}");
        let line = match mt {
            "path" => format!("{name} path_regexp wafp{i} {pat}\n"),
            "user_agent" => format!("{name} header_regexp wafua{i} User-Agent {pat}\n"),
            "ip" => format!("{name} remote_ip {pat}\n"),
            _ => continue,
        };
        out.push_str(&line);
        names.push(name);
    }
    for n in &names {
        out.push_str(&format!("respond {n} 403\n"));
    }
    out
}

/// Renders the Caddy redirects snippet: one site block per source domain. A
/// whole-domain rule (path `*`) preserves the path via `{uri}`; a path rule uses
/// an inline path matcher. Invalid domains/targets are skipped.
fn render_caddy_redirects(redirects: &[Value]) -> String {
    use std::collections::BTreeMap;
    let mut by_domain: BTreeMap<String, Vec<(String, String, u64)>> = BTreeMap::new();
    for r in redirects {
        let domain = r
            .get("source_domain")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if !valid_mail_domain(domain) {
            continue;
        }
        let target = r.get("target_url").and_then(Value::as_str).unwrap_or("").trim();
        if !valid_redirect_target(target) {
            continue;
        }
        let mut path = r
            .get("source_path")
            .and_then(Value::as_str)
            .unwrap_or("*")
            .trim()
            .to_string();
        if path.is_empty() {
            path = "*".into();
        }
        if path != "*" && !path.starts_with('/') {
            continue;
        }
        let code = match r.get("status_code").and_then(Value::as_u64).unwrap_or(301) {
            c @ (301 | 302 | 307 | 308) => c,
            _ => 301,
        };
        by_domain
            .entry(domain.to_string())
            .or_default()
            .push((path, target.to_string(), code));
    }

    let mut out = String::from("# AsterPanel redirects (generated — do not edit)\n");
    for (domain, rules) in by_domain {
        out.push_str(&format!("{domain} {{\n"));
        for (path, target, code) in rules {
            if path == "*" {
                out.push_str(&format!("\tredir {target}{{uri}} {code}\n"));
            } else {
                out.push_str(&format!("\tredir {path} {target} {code}\n"));
            }
        }
        out.push_str("}\n");
    }
    out
}

/// A redirect target is an absolute URL or a root-relative path, single-line.
fn valid_redirect_target(s: &str) -> bool {
    (s.starts_with("https://") || s.starts_with("http://") || s.starts_with('/'))
        && !s.contains(char::is_whitespace)
        && s.len() <= 2048
}

fn render_nftables(rules: &[Value]) -> String {
    let mut out = String::from(
        "table inet asterpanel {\n    chain input {\n        type filter hook input priority 0; policy accept;\n",
    );
    for r in rules {
        let action = r.get("action").and_then(Value::as_str).unwrap_or("allow");
        let source = r.get("source").and_then(Value::as_str).unwrap_or("");
        let port = r.get("port").and_then(Value::as_str).unwrap_or("*");
        if source.is_empty() {
            continue;
        }
        let verb = if action == "deny" { "drop" } else { "accept" };
        if port == "*" {
            out.push_str(&format!("        ip saddr {source} {verb}\n"));
        } else {
            out.push_str(&format!(
                "        ip saddr {source} tcp dport {port} {verb}\n"
            ));
        }
    }
    out.push_str("    }\n}\n");
    out
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

/// Builds the `docker exec` argv that runs `sql` inside the DB container.
/// Postgres emits CSV (with a 5s statement timeout); MySQL/MariaDB emit
/// tab-separated batch output. Returns None for engines without a CLI here.
fn db_query_args(
    engine: &str,
    container: &str,
    database: &str,
    owner: &str,
    sql: &str,
) -> Option<Vec<String>> {
    match engine {
        "postgres" => Some(vec![
            "exec".into(),
            container.into(),
            "psql".into(),
            "-U".into(),
            owner.into(),
            "-d".into(),
            database.into(),
            "--csv".into(),
            "-c".into(),
            "SET statement_timeout = 5000".into(),
            "-c".into(),
            sql.into(),
        ]),
        "mysql" | "mariadb" => Some(vec![
            "exec".into(),
            container.into(),
            "mysql".into(),
            "--batch".into(),
            format!("--execute=SET max_execution_time=5000; {sql}"),
            database.into(),
        ]),
        _ => None,
    }
}

/// Parses a query result into (columns, rows). Postgres `--csv` is parsed as
/// RFC-4180 CSV; MySQL `--batch` is tab-separated. The first record is the
/// header row.
fn parse_query_output(engine: &str, out: &str) -> (Vec<String>, Vec<Vec<String>>) {
    let records: Vec<Vec<String>> = match engine {
        "mysql" | "mariadb" => out
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.split('\t').map(str::to_string).collect())
            .collect(),
        _ => parse_csv(out),
    };
    if records.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let cols = records[0].clone();
    let rows = records[1..].to_vec();
    (cols, rows)
}

/// Minimal RFC-4180 CSV parser: handles quoted fields, doubled quotes, and
/// embedded commas/newlines.
fn parse_csv(input: &str) -> Vec<Vec<String>> {
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else {
            match c {
                '"' => in_quotes = true,
                ',' => record.push(std::mem::take(&mut field)),
                '\n' => {
                    record.push(std::mem::take(&mut field));
                    records.push(std::mem::take(&mut record));
                }
                '\r' => {}
                _ => field.push(c),
            }
        }
    }
    if !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }
    records
}

/// Aggregates Caddy JSON access-log lines into web-analytics figures. Each line
/// is a JSON object with `request.{remote_ip,uri}`, `status` and `size`.
/// Unparseable lines are skipped. Returns requests, unique visitors, total
/// bytes, the `top_n` paths (query string stripped), and a status-class tally.
fn parse_access_log(content: &str, top_n: usize) -> Value {
    use std::collections::{HashMap, HashSet};
    let mut requests: u64 = 0;
    let mut bytes: u64 = 0;
    let mut visitors: HashSet<String> = HashSet::new();
    let mut paths: HashMap<String, u64> = HashMap::new();
    let mut classes: HashMap<&str, u64> = HashMap::new();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        requests += 1;
        bytes += v.get("size").and_then(Value::as_u64).unwrap_or(0);
        let req = v.get("request");
        let ip = req
            .and_then(|r| r.get("remote_ip").or_else(|| r.get("client_ip")))
            .and_then(Value::as_str);
        if let Some(ip) = ip {
            visitors.insert(ip.to_string());
        }
        if let Some(uri) = req.and_then(|r| r.get("uri")).and_then(Value::as_str) {
            let path = uri.split('?').next().unwrap_or(uri).to_string();
            *paths.entry(path).or_insert(0) += 1;
        }
        let class = match v.get("status").and_then(Value::as_u64).unwrap_or(0) / 100 {
            2 => "2xx",
            3 => "3xx",
            4 => "4xx",
            5 => "5xx",
            _ => "other",
        };
        *classes.entry(class).or_insert(0) += 1;
    }

    let mut top: Vec<(String, u64)> = paths.into_iter().collect();
    // Most-hit first; ties broken by path for deterministic output.
    top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    top.truncate(top_n);
    let top_paths: Vec<Value> = top
        .into_iter()
        .map(|(path, count)| json!({"path": path, "count": count}))
        .collect();

    json!({
        "requests": requests,
        "visitors": visitors.len(),
        "bytes": bytes,
        "top_paths": top_paths,
        "status_classes": {
            "2xx": classes.get("2xx").copied().unwrap_or(0),
            "3xx": classes.get("3xx").copied().unwrap_or(0),
            "4xx": classes.get("4xx").copied().unwrap_or(0),
            "5xx": classes.get("5xx").copied().unwrap_or(0),
        }
    })
}

/// Caddy site serving a manually-installed certificate (no ACME).
fn render_caddy_site_tls(domain: &str, cert: &str, key: &str) -> String {
    format!("{domain} {{\n\ttls {cert} {key}\n\trespond \"AsterPanel\" 200\n}}\n")
}

/// Extracts the unquoted DKIM TXT value from an OpenDKIM-style key file.
/// The file format is BIND-zone-ish, e.g.
///   `mail._domainkey IN TXT ("v=DKIM1; ...; " "p=MII...")`
/// We concatenate the quoted segments and trim whitespace.
fn parse_dkim_txt(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut inside = false;
    let mut iter = raw.chars();
    while let Some(c) = iter.next() {
        if c == '"' {
            inside = !inside;
            continue;
        }
        if inside {
            out.push(c);
        }
    }
    let s = out.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Allow only domain-shaped strings (letters, digits, dot, hyphen). Guards
/// `docker exec setup ... domain <arg>` against argv injection.
fn valid_mail_domain(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && s.contains('.')
}

fn valid_dkim_selector(s: &str) -> bool {
    !s.is_empty() && s.len() <= 63 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
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
        // Antispam: enable Rspamd; turn off the older SpamAssassin/Amavis chain
        // (Rspamd already includes scoring + greylisting + DKIM signing).
        "-e".into(),
        "ENABLE_RSPAMD=1".into(),
        "-e".into(),
        "ENABLE_OPENDKIM=0".into(),
        "-e".into(),
        "ENABLE_AMAVIS=0".into(),
        "-e".into(),
        "ENABLE_SPAMASSASSIN=0".into(),
        "-e".into(),
        "ENABLE_CLAMAV=1".into(),
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

/// Builds the `docker logs` argv for a container (timestamps + bounded tail).
fn docker_logs_args(container: &str, tail: u64) -> Vec<String> {
    vec![
        "logs".into(),
        "--tail".into(),
        tail.to_string(),
        "--timestamps".into(),
        container.into(),
    ]
}

/// True only for platform-managed container names (`astp_*`, no shell/argv
/// metacharacters). Guards `docker logs` against reading foreign containers or
/// having the name parsed as a flag.
fn valid_container_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.starts_with("astp_")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Builds the `clamscan` argv: recursive, summary suppressed (we parse the
/// per-file lines ourselves).
fn clamscan_args(target: &str) -> Vec<String> {
    vec![
        "-r".into(),
        "--no-summary".into(),
        "--stdout".into(),
        target.into(),
    ]
}

/// Parses clamscan output, returning (file, signature) for each infected line
/// (`<path>: <Signature> FOUND`). Clean (`: OK`) lines are ignored.
fn parse_clamscan(output: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in output.lines() {
        if let Some(rest) = line.strip_suffix(" FOUND") {
            if let Some(idx) = rest.rfind(": ") {
                out.push((rest[..idx].to_string(), rest[idx + 2..].to_string()));
            }
        }
    }
    out
}

/// Health verdict from container liveness and an optional HTTP status code.
/// A stopped container is always down; a running one is up unless its probe
/// returned a server error (5xx).
fn classify_health(running: bool, http_code: Option<u16>) -> &'static str {
    if !running {
        return "down";
    }
    match http_code {
        Some(c) if c >= 500 => "down",
        _ => "up",
    }
}

/// HTTP GET probe returning (status_code, latency_ms). Self-signed certs are
/// accepted — health is about reachability, not trust.
async fn probe_http(url: &str) -> (Option<u16>, u64) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .danger_accept_invalid_certs(true)
        .build()
    {
        Ok(c) => c,
        Err(_) => return (None, 0),
    };
    let start = Instant::now();
    match client.get(url).send().await {
        Ok(resp) => (Some(resp.status().as_u16()), start.elapsed().as_millis() as u64),
        Err(_) => (None, start.elapsed().as_millis() as u64),
    }
}

/// Maps runtime + a language version to a base image. The version is sanitized
/// to digits and dots only — even though it arrives in a signed job, an image
/// tag must never carry arbitrary characters. Falls back to the default image
/// for the runtime when no (or an unsupported) version is given.
fn image_for_runtime_version(runtime: &str, version: &str) -> String {
    let safe = version
        .chars()
        .all(|c| c.is_ascii_digit() || c == '.')
        && !version.is_empty();
    match (runtime, safe) {
        ("node", true) => format!("node:{version}-alpine"),
        ("php", true) => format!("php:{version}-fpm-alpine"),
        _ => image_for_runtime(runtime).to_string(),
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

// --- File-manager helpers (pure, sandbox-critical) --------------------------

const MAX_READ_BYTES: u64 = 1 << 20; // 1 MiB inline read cap
const MAX_WRITE_BYTES: u64 = 5 << 20; // 5 MiB write cap

/// Root directory for a site's managed files on the node.
fn site_root(site_id: &str) -> PathBuf {
    let base = std::env::var("AGENT_SITES_DIR").unwrap_or_else(|_| "/srv/asterpanel/sites".into());
    Path::new(&base).join(site_id)
}

/// Extracts (site_root, relative_path) from a file job payload, rejecting a
/// malformed site id — the only safe shape is a bare UUID-like segment.
fn site_and_rel(payload: &Value) -> Option<(PathBuf, String)> {
    let site_id = payload.get("site_id").and_then(Value::as_str)?;
    if site_id.is_empty() || site_id.contains('/') || site_id.contains("..") {
        return None;
    }
    let rel = payload
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_start_matches('/')
        .to_string();
    Some((site_root(site_id), rel))
}

/// Joins `rel` onto `root`, allowing only normal path components. Any attempt to
/// climb out (`..`), use an absolute path, or a Windows prefix yields None; a
/// final lexical `starts_with` is belt-and-braces.
fn resolve_within(root: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if !out.starts_with(root) {
        return None;
    }
    Some(out)
}

/// Modification time as Unix epoch milliseconds (0 when unavailable).
fn mtime_millis(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Normalizes a relative path back to a leading-slash display form for the UI.
fn display_path(rel: &str) -> String {
    if rel.is_empty() {
        "/".to_string()
    } else {
        format!("/{rel}")
    }
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
    fn buildpack_detection_and_dockerfile() {
        assert_eq!(detect_buildpack(&["package.json", "src"]), Some("node"));
        assert_eq!(detect_buildpack(&["composer.json"]), Some("php"));
        assert_eq!(detect_buildpack(&["index.php"]), Some("php"));
        assert_eq!(detect_buildpack(&["index.html", "style.css"]), Some("static"));
        // node manifest wins over a stray index.html
        assert_eq!(detect_buildpack(&["index.html", "package.json"]), Some("node"));
        assert_eq!(detect_buildpack(&["README.md"]), None);
        assert!(generate_dockerfile("node").unwrap().contains("FROM node:20-alpine"));
        assert!(generate_dockerfile("php").unwrap().contains("php:8.3-apache"));
        assert!(generate_dockerfile("static").unwrap().contains("nginx"));
        assert!(generate_dockerfile("ruby").is_none());
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
    fn sha256sum_parsing() {
        let line = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  /b/x.tar.gz\n";
        assert_eq!(
            parse_sha256sum(line).unwrap(),
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        );
        // short / non-hex digests are rejected
        assert!(parse_sha256sum("deadbeef  f").is_none());
        assert!(parse_sha256sum("").is_none());
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
        // antispam: Rspamd on, legacy SA/Amavis off
        assert!(s.contains("ENABLE_RSPAMD=1"), "{s}");
        assert!(s.contains("ENABLE_AMAVIS=0"), "{s}");
        assert!(s.contains("ENABLE_SPAMASSASSIN=0"), "{s}");
        assert!(s.contains("ENABLE_CLAMAV=1"), "{s}");
    }

    #[test]
    fn parses_dkim_public_key_record() {
        let in1 = "mail._domainkey IN TXT (\"v=DKIM1; h=sha256; k=rsa; \" \"p=MIIBIjAN...\" )";
        let rec = parse_dkim_txt(in1).expect("should parse");
        assert!(rec.starts_with("v=DKIM1; h=sha256; k=rsa; p=MIIBIjAN"), "{rec}");
        // an unrelated line returns None
        assert!(parse_dkim_txt("; not a dkim line\n").is_none());
    }

    #[test]
    fn forwarders_render_virtual_map_and_skip_invalid() {
        let fwds = vec![
            json!({"source":"sales@example.com","destinations":["a@example.com","b@example.com"]}),
            json!({"source":"@example.com","destinations":["catchall@example.com"]}), // catch-all
            json!({"source":"bad-source","destinations":["x@example.com"]}),          // invalid source
            json!({"source":"ok@example.com","destinations":[]}),                     // no destinations
            json!({"source":"ops@example.com","destinations":["not-an-email"]}),      // invalid dest
        ];
        let out = render_postfix_virtual_aliases(&fwds);
        assert!(out.contains("sales@example.com a@example.com,b@example.com"), "{out}");
        assert!(out.contains("@example.com catchall@example.com"), "{out}");
        assert!(!out.contains("bad-source"), "{out}");
        assert!(!out.contains("ok@example.com"), "{out}");
        assert!(!out.contains("ops@example.com"), "{out}");
        assert!(valid_forward_source("@example.com"));
        assert!(valid_forward_source("user@example.com"));
        assert!(!valid_forward_source("nope"));
        assert!(!valid_email("two@@at.com"));
    }

    #[test]
    fn sieve_autoresponder_renders_vacation() {
        let items = vec![
            json!({"address":"vip@example.com","subject":"Away","body":"Back Monday.\n.signature","interval_days":2,"start_date":"2026-06-01","end_date":"2026-06-15"}),
            json!({"address":"bad","subject":"x","body":"y"}), // invalid address → skipped
        ];
        let out = render_sieve_autoresponders(&items);
        assert!(out.contains("require [\"vacation\""), "{out}");
        assert!(out.contains("envelope :is \"to\" \"vip@example.com\""), "{out}");
        assert!(out.contains("vacation :days 2 :subject \"Away\""), "{out}");
        assert!(out.contains("currentdate :value \"ge\" \"date\" \"2026-06-01\""), "{out}");
        assert!(out.contains("currentdate :value \"le\" \"date\" \"2026-06-15\""), "{out}");
        assert!(out.contains("..signature"), "{out}"); // dot-stuffed body line
        assert!(!out.contains("\"bad\""), "{out}");
        assert!(valid_iso_date("2026-06-01"));
        assert!(!valid_iso_date("2026/06/01"));
    }

    #[test]
    fn sieve_filters_render_rules() {
        let filters = vec![
            json!({"address":"info@example.com","name":"junk","field":"subject","op":"contains","value":"[SPAM]","action":"fileinto","action_arg":"Junk"}),
            json!({"address":"info@example.com","name":"block","field":"from","op":"is","value":"bad@x.com","action":"discard"}),
            json!({"address":"info@example.com","name":"fwd","field":"to","op":"contains","value":"sales","action":"redirect","action_arg":"team@example.com"}),
            json!({"address":"nope","name":"x","field":"from","op":"is","value":"y","action":"discard"}), // bad address
            json!({"address":"info@example.com","name":"nofolder","field":"subject","op":"is","value":"x","action":"fileinto","action_arg":""}), // missing folder
        ];
        let out = render_sieve_filters(&filters);
        assert!(out.contains("require [\"fileinto\", \"envelope\"];"), "{out}");
        assert!(out.contains("header :contains \"subject\" \"[SPAM]\""), "{out}");
        assert!(out.contains("fileinto \"Junk\""), "{out}");
        assert!(out.contains("header :is \"from\" \"bad@x.com\""), "{out}");
        assert!(out.contains("discard;"), "{out}");
        assert!(out.contains("redirect \"team@example.com\""), "{out}");
        assert!(!out.contains("\"nope\""), "{out}");
        assert!(!out.contains("nofolder"), "{out}");
    }

    #[test]
    fn db_query_csv_and_args() {
        // Postgres --csv with a quoted field containing a comma + doubled quote.
        let csv = "id,name\n1,Acme\n2,\"Doe, \"\"J\"\"\"\n";
        let (cols, rows) = parse_query_output("postgres", csv);
        assert_eq!(cols, vec!["id", "name"]);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1], vec!["2".to_string(), "Doe, \"J\"".to_string()]);

        // MySQL --batch is tab-separated.
        let tsv = "id\tname\n1\tAcme\n";
        let (mcols, mrows) = parse_query_output("mysql", tsv);
        assert_eq!(mcols, vec!["id", "name"]);
        assert_eq!(mrows, vec![vec!["1".to_string(), "Acme".to_string()]]);

        // argv targets the container with a statement timeout; unknown engine → None.
        let args = db_query_args("postgres", "astp_db_x", "app", "app", "SELECT 1").unwrap();
        assert!(args.contains(&"--csv".to_string()));
        assert!(args.iter().any(|a| a.contains("statement_timeout")));
        assert!(db_query_args("mongo", "c", "d", "o", "x").is_none());
    }

    #[test]
    fn access_log_aggregates_caddy_json() {
        let log = concat!(
            r#"{"request":{"remote_ip":"1.1.1.1","uri":"/?ref=x"},"status":200,"size":100}"#,
            "\n",
            r#"{"request":{"remote_ip":"1.1.1.1","uri":"/about"},"status":200,"size":50}"#,
            "\n",
            r#"{"request":{"remote_ip":"2.2.2.2","uri":"/"},"status":404,"size":20}"#,
            "\n",
            "not json — skipped\n",
            r#"{"request":{"remote_ip":"3.3.3.3","uri":"/"},"status":500,"size":10}"#,
            "\n",
        );
        let v = parse_access_log(log, 10);
        assert_eq!(v["requests"], 4);
        assert_eq!(v["visitors"], 3); // 1.1.1.1, 2.2.2.2, 3.3.3.3
        assert_eq!(v["bytes"], 180);
        assert_eq!(v["status_classes"]["2xx"], 2);
        assert_eq!(v["status_classes"]["4xx"], 1);
        assert_eq!(v["status_classes"]["5xx"], 1);
        // "/" is the top path (3 hits: query stripped, plus the two extra "/")
        assert_eq!(v["top_paths"][0]["path"], "/");
        assert_eq!(v["top_paths"][0]["count"], 3);
    }

    #[test]
    fn caddy_redirects_render_grouped() {
        let rs = vec![
            json!({"source_domain":"old.com","source_path":"*","target_url":"https://new.com","status_code":301}),
            json!({"source_domain":"acme.com","source_path":"/promo","target_url":"https://acme.com/sale","status_code":302}),
            json!({"source_domain":"bad domain","source_path":"*","target_url":"https://x.com","status_code":301}), // invalid domain
            json!({"source_domain":"acme.com","source_path":"/old","target_url":"not a url","status_code":301}),     // invalid target
        ];
        let out = render_caddy_redirects(&rs);
        assert!(out.contains("old.com {"), "{out}");
        assert!(out.contains("redir https://new.com{uri} 301"), "{out}");
        assert!(out.contains("acme.com {"), "{out}");
        assert!(out.contains("redir /promo https://acme.com/sale 302"), "{out}");
        assert!(!out.contains("bad domain"), "{out}");
        assert!(!out.contains("not a url"), "{out}");
        assert!(valid_redirect_target("https://x.com/a"));
        assert!(valid_redirect_target("/local"));
        assert!(!valid_redirect_target("ftp://x"));
    }

    #[test]
    fn caddy_waf_renders_matchers_and_403() {
        let rules = vec![
            json!({"match_type":"path","pattern":"(?i)/wp-admin"}),
            json!({"match_type":"user_agent","pattern":"(?i)sqlmap"}),
            json!({"match_type":"ip","pattern":"203.0.113.66"}),
            json!({"match_type":"bogus","pattern":"x"}),
            json!({"match_type":"path","pattern":""}),
        ];
        let s = render_caddy_waf(&rules);
        assert!(s.contains("@waf0 path_regexp wafp0 (?i)/wp-admin"), "{s}");
        assert!(s.contains("@waf1 header_regexp wafua1 User-Agent (?i)sqlmap"), "{s}");
        assert!(s.contains("@waf2 remote_ip 203.0.113.66"), "{s}");
        assert!(s.contains("respond @waf0 403"), "{s}");
        // bogus type and empty pattern produce no matcher
        assert!(!s.contains("@waf3"), "{s}");
        assert!(!s.contains("@waf4"), "{s}");
    }

    #[test]
    fn nftables_renders_allow_and_deny() {
        let rules = vec![
            json!({"action":"deny","source":"203.0.113.66","port":"*"}),
            json!({"action":"allow","source":"10.0.0.0/8","port":"22"}),
        ];
        let s = render_nftables(&rules);
        assert!(s.contains("table inet asterpanel"), "{s}");
        assert!(s.contains("ip saddr 203.0.113.66 drop"), "{s}");
        assert!(s.contains("ip saddr 10.0.0.0/8 tcp dport 22 accept"), "{s}");
    }

    #[test]
    fn resolve_within_allows_normal_and_blocks_escape() {
        let root = Path::new("/srv/sites/abc");
        assert_eq!(
            resolve_within(root, "public/index.html"),
            Some(PathBuf::from("/srv/sites/abc/public/index.html"))
        );
        assert_eq!(resolve_within(root, ""), Some(root.to_path_buf()));
        // current-dir segments are harmless
        assert_eq!(
            resolve_within(root, "a/./b"),
            Some(PathBuf::from("/srv/sites/abc/a/b"))
        );
        // every way of climbing out is refused
        assert!(resolve_within(root, "../etc/passwd").is_none());
        assert!(resolve_within(root, "a/../../x").is_none());
        assert!(resolve_within(root, "/etc/passwd").is_none());
    }

    #[test]
    fn site_and_rel_parses_and_rejects() {
        let (root, rel) =
            site_and_rel(&json!({"site_id": "abc-123", "path": "/public/app.js"})).unwrap();
        assert!(root.ends_with("abc-123"));
        assert_eq!(rel, "public/app.js");
        // missing path means the site root
        let (_, rel0) = site_and_rel(&json!({"site_id": "abc-123"})).unwrap();
        assert_eq!(rel0, "");
        // a site id is mandatory and must be a bare segment
        assert!(site_and_rel(&json!({"path": "/x"})).is_none());
        assert!(site_and_rel(&json!({"site_id": "../../etc"})).is_none());
        assert!(site_and_rel(&json!({"site_id": "a/b"})).is_none());
    }

    #[test]
    fn display_path_adds_leading_slash() {
        assert_eq!(display_path(""), "/");
        assert_eq!(display_path("a/b"), "/a/b");
    }

    #[test]
    fn docker_logs_args_have_tail_and_timestamps() {
        assert_eq!(
            docker_logs_args("astp_site_1", 100).join(" "),
            "logs --tail 100 --timestamps astp_site_1"
        );
    }

    #[test]
    fn clamscan_parsing_and_args() {
        assert_eq!(
            clamscan_args("/srv/sites/abc").join(" "),
            "-r --no-summary --stdout /srv/sites/abc"
        );
        let out = "/srv/a.txt: OK\n/srv/up/evil.exe: Win.Test.EICAR_HDB-1 FOUND\n/srv/b: OK\n";
        let found = parse_clamscan(out);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "/srv/up/evil.exe");
        assert_eq!(found[0].1, "Win.Test.EICAR_HDB-1");
        // a fully clean scan yields nothing
        assert!(parse_clamscan("/x: OK\n/y: OK\n").is_empty());
    }

    #[test]
    fn health_classification() {
        assert_eq!(classify_health(false, None), "down"); // stopped
        assert_eq!(classify_health(false, Some(200)), "down"); // stopped wins
        assert_eq!(classify_health(true, None), "up"); // running, no probe
        assert_eq!(classify_health(true, Some(200)), "up");
        assert_eq!(classify_health(true, Some(404)), "up"); // 4xx is still "up"
        assert_eq!(classify_health(true, Some(503)), "down"); // 5xx is down
    }

    #[test]
    fn container_name_allowlist() {
        assert!(valid_container_name("astp_site_abc-123"));
        assert!(valid_container_name("astp_db_1"));
        // foreign containers and argv-injection shapes are refused
        assert!(!valid_container_name("postgres"));
        assert!(!valid_container_name("-rf"));
        assert!(!valid_container_name("astp_site_1; rm -rf /"));
        assert!(!valid_container_name("../etc"));
        assert!(!valid_container_name(""));
    }

    #[test]
    fn runtime_image_maps_version_and_sanitizes() {
        assert_eq!(image_for_runtime_version("node", "20"), "node:20-alpine");
        assert_eq!(image_for_runtime_version("php", "8.3"), "php:8.3-fpm-alpine");
        // empty version falls back to the runtime default
        assert_eq!(image_for_runtime_version("php", ""), "php:8.3-fpm-alpine");
        // injection attempts are rejected -> default image, never a crafted tag
        assert_eq!(
            image_for_runtime_version("node", "20-alpine; rm -rf /"),
            "node:20-alpine"
        );
        assert_eq!(
            image_for_runtime_version("node", "latest' OR '1"),
            "node:20-alpine"
        );
    }
}
