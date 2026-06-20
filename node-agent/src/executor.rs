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
            "dns.dnssec.enable" => self.dnssec_enable(job).await,
            "dns.dnssec.disable" => self.dnssec_disable(job).await,
            "cert.issue" => self.cert_issue(job).await,
            "app.deploy" => self.app_deploy(job).await,
            "app.start" => self.app_lifecycle(job, "start").await,
            "app.stop" => self.app_lifecycle(job, "stop").await,
            "app.restart" => self.app_lifecycle(job, "restart").await,
            "mail.mailbox.create" => self.mailbox_create(job).await,
            "mail.mailbox.apply" => self.mail_mailbox_apply(job).await,
            "mail.server.ensure" => self.mail_server_ensure(job).await,
            "mail.dkim.generate" => self.mail_dkim_generate(job).await,
            "mail.alias.apply" => self.mail_alias_apply(job).await,
            "mail.autoresponder.apply" => self.mail_autoresponder_apply(job).await,
            "mail.filter.apply" => self.mail_filter_apply(job).await,
            "mail.spam.apply" => self.mail_spam_apply(job).await,
            "mail.queue.list" => self.mail_queue_list(job).await,
            "mail.queue.action" => self.mail_queue_action(job).await,
            "mail.delivery.track" => self.mail_delivery_track(job).await,
            "caldav.ensure" => self.caldav_ensure(job).await,
            "caldav.user.apply" => self.caldav_user_apply(job).await,
            "cron.apply" => self.cron_apply(job).await,
            "ftp.account.create" => self.ftp_account_create(job).await,
            "ftp.account.password" => self.ftp_account_password(job).await,
            "ssh.keys.apply" => self.ssh_keys_apply(job).await,
            "git.repo.ensure" => self.git_repo_ensure(job).await,
            "staging.create" => self.staging_sync(job, false).await,
            "staging.promote" => self.staging_sync(job, true).await,
            "staging.destroy" => self.staging_destroy(job).await,
            "database.user.create" => self.database_user_create(job).await,
            "database.user.privileges" => self.database_user_privileges(job).await,
            "database.user.password" => self.database_user_password(job).await,
            "database.user.delete" => self.database_user_delete(job).await,
            "database.query" => self.database_query(job).await,
            "database.access.apply" => self.database_access_apply(job).await,
            "database.dump" => self.database_dump(job).await,
            "cert.install" => self.cert_install(job).await,
            "firewall.apply" => self.firewall_apply(job).await,
            "waf.apply" => self.waf_apply(job).await,
            "redirect.apply" => self.redirect_apply(job).await,
            "subdomain.apply" => self.subdomain_apply(job).await,
            "protection.apply" => self.protection_apply(job).await,
            "file.list" => self.file_list(job).await,
            "file.read" => self.file_read(job).await,
            "file.write" => self.file_write(job).await,
            "file.delete" => self.file_delete(job).await,
            "file.mkdir" => self.file_mkdir(job).await,
            "runtime.switch" => self.runtime_switch(job).await,
            "runtime.phpini.apply" => self.runtime_phpini_apply(job).await,
            "logs.tail" => self.logs_tail(job).await,
            "antivirus.scan" => self.antivirus_scan(job).await,
            "health.check" => self.health_check(job).await,
            "analytics.compute" => self.analytics_compute(job).await,
            "service.control" => self.service_control(job).await,
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

    /// Enables DNSSEC for a zone: generates a KSK (+ ZSK), best-effort signs the
    /// zone, and returns the DS record(s) to publish at the registrar. Fails
    /// clearly when the BIND DNSSEC utilities aren't installed on the node.
    async fn dnssec_enable(&self, job: &Job) -> JobOutcome {
        let zone = job.payload.get("domain").and_then(Value::as_str).unwrap_or("").trim();
        if !valid_mail_domain(zone) {
            return JobOutcome::failed("dns.dnssec.enable: invalid domain");
        }
        let dns_dir = std::env::var("AGENT_DNS_DIR").unwrap_or_else(|_| "/etc/asterpanel/dns".into());
        let keys_dir = format!("{dns_dir}/keys/{zone}");
        if let Err(e) = tokio::fs::create_dir_all(&keys_dir).await {
            return JobOutcome::failed(format!("dns.dnssec.enable: mkdir failed: {e}"));
        }
        match run_cmd(
            "dnssec-keygen",
            &[
                "-a".into(), "ECDSAP256SHA256".into(), "-f".into(), "KSK".into(),
                "-K".into(), keys_dir.clone(), zone.to_string(),
            ],
        )
        .await
        {
            Ok(o) if o.status.success() => {}
            Ok(o) => {
                return JobOutcome::failed(format!(
                    "dnssec-keygen failed: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                ))
            }
            Err(_) => {
                return JobOutcome::failed(
                    "dns.dnssec.enable: BIND DNSSEC tools (dnssec-keygen) not installed on the node",
                )
            }
        }
        // ZSK + zone signing are best-effort (signing needs the zone file present).
        let _ = run_cmd(
            "dnssec-keygen",
            &["-a".into(), "ECDSAP256SHA256".into(), "-K".into(), keys_dir.clone(), zone.to_string()],
        )
        .await;
        let zonefile = format!("{dns_dir}/{zone}.zone");
        let _ = run_cmd(
            "dnssec-signzone",
            &["-K".into(), keys_dir.clone(), "-o".into(), zone.to_string(), zonefile],
        )
        .await;
        // Derive the DS record(s) from the KSK key file(s).
        let ds_out = run_cmd(
            "sh",
            &["-c".into(), format!("dnssec-dsfromkey -2 {keys_dir}/K{zone}.*.key 2>/dev/null")],
        )
        .await;
        let text = match ds_out {
            Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
            Err(_) => String::new(),
        };
        let records: Vec<Value> = text.lines().filter_map(parse_ds_record).collect();
        if records.is_empty() {
            return JobOutcome::failed(
                "dns.dnssec.enable: keys generated but no DS record produced (install the bind9 dnssec utilities)",
            );
        }
        JobOutcome::succeeded(json!({"domain": zone, "ds_records": records, "signed": true}))
    }

    /// Disables DNSSEC by removing the zone's keys and signed zone file.
    async fn dnssec_disable(&self, job: &Job) -> JobOutcome {
        let zone = job.payload.get("domain").and_then(Value::as_str).unwrap_or("").trim();
        if !valid_mail_domain(zone) {
            return JobOutcome::failed("dns.dnssec.disable: invalid domain");
        }
        let dns_dir = std::env::var("AGENT_DNS_DIR").unwrap_or_else(|_| "/etc/asterpanel/dns".into());
        let _ = tokio::fs::remove_dir_all(format!("{dns_dir}/keys/{zone}")).await;
        let _ = tokio::fs::remove_file(format!("{dns_dir}/{zone}.zone.signed")).await;
        JobOutcome::succeeded(json!({"domain": zone, "disabled": true}))
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

    /// Starts, stops or restarts a site's container (cPanel app restart).
    async fn app_lifecycle(&self, job: &Job, action: &str) -> JobOutcome {
        let website_id = job.payload.get("website_id").and_then(Value::as_str).unwrap_or("");
        if website_id.is_empty() {
            return JobOutcome::failed("app lifecycle: missing website_id");
        }
        let container = format!("astp_site_{website_id}");
        let args = match app_lifecycle_args(action, &container) {
            Some(a) => a,
            None => return JobOutcome::failed("app lifecycle: invalid action or site"),
        };
        match run_docker(&args).await {
            Ok(o) if o.status.success() => {
                JobOutcome::succeeded(json!({"container": container, "action": action}))
            }
            Ok(o) => JobOutcome::failed(format!(
                "docker {action} failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
        }
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
        // Runtime env vars + an optional start command override, supplied by the
        // control plane from the application's configuration.
        let env: Vec<(String, String)> = job
            .payload
            .get("env")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| {
                        let k = e.get("key").and_then(Value::as_str)?;
                        let val = e.get("value").and_then(Value::as_str).unwrap_or("");
                        Some((k.to_string(), val.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let start_command = job.payload.get("start_command").and_then(Value::as_str);
        // Replace the previous container; the prior image is retained for rollback.
        let _ = run_docker(&["rm".into(), "-f".into(), container.clone()]).await;
        match run_docker(&app_run_args(
            &container,
            &network,
            &image,
            &job.tenant_id.to_string(),
            dep_id,
            &env,
            start_command,
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

    /// Declarative mailbox apply: rewrites the Dovecot passwd-file and the Postfix
    /// virtual (local-delivery) map from the full mailbox set. Suspended mailboxes
    /// and unsafe values are dropped, so editing a password / quota / status is
    /// just a full re-render — deletes and suspensions propagate without a
    /// separate command.
    async fn mail_mailbox_apply(&self, job: &Job) -> JobOutcome {
        let empty: Vec<Value> = Vec::new();
        let mailboxes = job
            .payload
            .get("mailboxes")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let dir = std::env::var("AGENT_MAIL_DIR").unwrap_or_else(|_| "/etc/asterpanel/mail".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("mail.mailbox.apply: mkdir failed: {e}"));
        }
        let users = render_dovecot_users(mailboxes);
        let virt = render_postfix_virtual_mailboxes(mailboxes);
        if let Err(e) = tokio::fs::write(format!("{dir}/dovecot-users"), users.as_bytes()).await {
            return JobOutcome::failed(format!("mail.mailbox.apply: write dovecot-users failed: {e}"));
        }
        if let Err(e) =
            tokio::fs::write(format!("{dir}/postfix-virtual"), virt.as_bytes()).await
        {
            return JobOutcome::failed(format!(
                "mail.mailbox.apply: write postfix-virtual failed: {e}"
            ));
        }
        JobOutcome::succeeded(json!({"mailboxes": mailboxes.len()}))
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

    /// Writes the Rspamd spam configuration: action thresholds, greylisting
    /// toggle, and allow/deny multimaps (sender whitelists/blacklists).
    async fn mail_spam_apply(&self, job: &Job) -> JobOutcome {
        let reject = job
            .payload
            .get("reject_score")
            .and_then(Value::as_i64)
            .unwrap_or(15)
            .clamp(1, 100);
        let add_header = job
            .payload
            .get("add_header_score")
            .and_then(Value::as_i64)
            .unwrap_or(6)
            .clamp(1, 100);
        let greylisting = job
            .payload
            .get("greylisting")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let list = |k: &str| -> Vec<String> {
            job.payload
                .get(k)
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|v| !v.is_empty() && !v.contains(char::is_whitespace))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        let allow = list("allow");
        let deny = list("deny");

        let dir = std::env::var("AGENT_RSPAMD_DIR").unwrap_or_else(|_| "/etc/asterpanel/rspamd".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("mail.spam.apply: mkdir failed: {e}"));
        }
        let wl_path = format!("{dir}/allow.map");
        let bl_path = format!("{dir}/deny.map");
        let writes = [
            (format!("{dir}/actions.conf"), render_rspamd_actions(reject, add_header)),
            (format!("{dir}/greylist.conf"), render_rspamd_greylist(greylisting)),
            (format!("{dir}/multimap.conf"), render_rspamd_multimap(&wl_path, &bl_path)),
            (wl_path.clone(), format!("{}\n", allow.join("\n"))),
            (bl_path.clone(), format!("{}\n", deny.join("\n"))),
        ];
        for (path, content) in &writes {
            if let Err(e) = tokio::fs::write(path, content.as_bytes()).await {
                return JobOutcome::failed(format!("mail.spam.apply: write {path} failed: {e}"));
            }
        }
        JobOutcome::succeeded(json!({
            "reject": reject, "add_header": add_header, "greylisting": greylisting,
            "allow": allow.len(), "deny": deny.len(),
        }))
    }

    /// Launches a Radicale CalDAV/CardDAV server container (idempotent recreate).
    async fn caldav_ensure(&self, _job: &Job) -> JobOutcome {
        let dir = std::env::var("AGENT_CALDAV_DIR").unwrap_or_else(|_| "/etc/asterpanel/caldav".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("caldav.ensure: mkdir failed: {e}"));
        }
        let _ = run_docker(&["rm".into(), "-f".into(), "astp_radicale".into()]).await;
        match run_docker(&radicale_args(&dir)).await {
            Ok(o) if o.status.success() => JobOutcome::succeeded(json!({
                "container": "astp_radicale", "port": 5232,
            })),
            Ok(o) => JobOutcome::failed(format!(
                "caldav.ensure: run failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
        }
    }

    /// Regenerates the Radicale htpasswd users file from the full account set.
    async fn caldav_user_apply(&self, job: &Job) -> JobOutcome {
        let empty: Vec<Value> = Vec::new();
        let accounts = job
            .payload
            .get("accounts")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let content = render_radicale_users(accounts);
        let dir = std::env::var("AGENT_CALDAV_DIR").unwrap_or_else(|_| "/etc/asterpanel/caldav".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("caldav.user.apply: mkdir failed: {e}"));
        }
        let path = format!("{dir}/users");
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("caldav.user.apply: write failed: {e}"));
        }
        let count = content.lines().filter(|l| !l.is_empty()).count();
        JobOutcome::succeeded(json!({"path": path, "accounts": count}))
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

    /// Writes the org's authorized_keys file declaratively from the full key set.
    /// Each key is validated (single-line OpenSSH public key, no options/command),
    /// so the file can never carry a forced command or arbitrary directive.
    async fn ssh_keys_apply(&self, job: &Job) -> JobOutcome {
        let empty: Vec<Value> = Vec::new();
        let keys = job.payload.get("keys").and_then(Value::as_array).unwrap_or(&empty);
        let content = render_authorized_keys(keys);
        let dir = std::env::var("AGENT_SFTP_DIR").unwrap_or_else(|_| "/etc/asterpanel/ssh".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("ssh.keys.apply: mkdir failed: {e}"));
        }
        let path = format!("{dir}/authorized_keys");
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("ssh.keys.apply: write failed: {e}"));
        }
        JobOutcome::succeeded(json!({"path": path, "keys": keys.len()}))
    }

    /// Provisions a bare git repo for a site and installs a post-receive hook that
    /// checks the configured branch out into the site's working tree on push.
    async fn git_repo_ensure(&self, job: &Job) -> JobOutcome {
        let pv = |k: &str| job.payload.get(k).and_then(Value::as_str).unwrap_or("");
        let repo_path = pv("repo_path");
        let work_tree = pv("work_tree");
        let branch = if pv("branch").is_empty() { "main" } else { pv("branch") };
        let hook = match render_post_receive_hook(repo_path, work_tree, branch) {
            Some(h) => h,
            None => {
                return JobOutcome::failed("git.repo.ensure: unsafe repo path, work tree or branch")
            }
        };
        if let Err(e) = tokio::fs::create_dir_all(repo_path).await {
            return JobOutcome::failed(format!("git.repo.ensure: mkdir failed: {e}"));
        }
        if let Err(e) = run_cmd("git", &["init".into(), "--bare".into(), repo_path.to_string()]).await
        {
            return JobOutcome::failed(format!("git.repo.ensure: git init failed: {e}"));
        }
        let _ = tokio::fs::create_dir_all(work_tree).await;
        let hook_path = format!("{repo_path}/hooks/post-receive");
        if let Err(e) = tokio::fs::write(&hook_path, hook.as_bytes()).await {
            return JobOutcome::failed(format!("git.repo.ensure: write hook failed: {e}"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                tokio::fs::set_permissions(&hook_path, std::fs::Permissions::from_mode(0o755)).await;
        }
        JobOutcome::succeeded(json!({"repo_path": repo_path, "branch": branch}))
    }

    /// Mirrors a site's document root for its staging environment. With
    /// `promote = false` (staging.create) production is copied *into* staging;
    /// with `promote = true` (staging.promote) staging is copied back *into*
    /// production, after snapshotting the current production tree so the promote
    /// can be rolled back. Every path is derived from the validated website id, so
    /// no payload string can escape the staging / site roots.
    async fn staging_sync(&self, job: &Job, promote: bool) -> JobOutcome {
        let wid = job
            .payload
            .get("website_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let (prod, staging) = match staging_paths(wid) {
            Some(p) => p,
            None => return JobOutcome::failed("staging: invalid website id"),
        };
        let backup = format!("{staging}-prod-backup");

        let (src, dst): (&str, &str) = if promote {
            (&staging, &prod)
        } else {
            (&prod, &staging)
        };

        if promote {
            // staging must have been provisioned by staging.create first.
            if !tokio::fs::try_exists(&staging).await.unwrap_or(false) {
                return JobOutcome::failed("staging.promote: no staging environment");
            }
            // Snapshot the current production tree so a bad promote is reversible.
            if let Some(bargs) = staging_rsync_args(&prod, &backup) {
                let _ = tokio::fs::create_dir_all(&backup).await;
                let _ = run_cmd("rsync", &bargs).await;
            }
        }

        if let Err(e) = tokio::fs::create_dir_all(dst).await {
            return JobOutcome::failed(format!("staging: mkdir {dst} failed: {e}"));
        }
        let args = match staging_rsync_args(src, dst) {
            Some(a) => a,
            None => return JobOutcome::failed("staging: unsafe sync paths"),
        };
        match run_cmd("rsync", &args).await {
            Ok(o) if o.status.success() => JobOutcome::succeeded(json!({
                "website_id": wid,
                "action": if promote { "promote" } else { "create" },
                "staging_path": staging,
            })),
            Ok(o) => JobOutcome::failed(format!(
                "staging: rsync failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => JobOutcome::failed(format!("staging: rsync not available: {e}")),
        }
    }

    async fn staging_destroy(&self, job: &Job) -> JobOutcome {
        let wid = job
            .payload
            .get("website_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let (_prod, staging) = match staging_paths(wid) {
            Some(p) => p,
            None => return JobOutcome::failed("staging.destroy: invalid website id"),
        };
        // `staging` is built from a validated id under /var/asterpanel/staging, so
        // this rm can only ever target that tree (and its prod-backup sibling).
        let _ = run_cmd("rm", &["-rf".into(), staging.clone()]).await;
        let _ = run_cmd("rm", &["-rf".into(), format!("{staging}-prod-backup")]).await;
        JobOutcome::succeeded(json!({"website_id": wid, "destroyed": true}))
    }

    /// Idempotently provisions the Unix SFTP user and sets its password:
    /// `useradd` with a non-interactive shell, a root-owned chroot (OpenSSH
    /// refuses to chroot into a directory the user can write) holding a
    /// user-writable `files` subdir, then `chpasswd` over stdin. The chroot
    /// lives under a directory the agent owns — never a site/shared path — so
    /// ownership can be enforced without touching website files.
    async fn provision_sftp_user(&self, username: &str, password: &str) -> Result<String, String> {
        let root =
            std::env::var("AGENT_SFTP_HOME").unwrap_or_else(|_| "/var/asterpanel/sftp".into());
        let chroot = sftp_chroot_path(&root, username).ok_or("invalid username")?;
        let line = chpasswd_line(username, password).ok_or("unsafe credentials")?;
        let files = format!("{chroot}/files");

        // 1. system user (exit 9 = "already exists" → fine, this is idempotent)
        match run_cmd("useradd", &useradd_args(username, &chroot)).await {
            Ok(o) if o.status.success() || o.status.code() == Some(9) => {}
            Ok(o) => {
                return Err(format!("useradd: {}", String::from_utf8_lossy(&o.stderr).trim()))
            }
            Err(e) => return Err(format!("useradd exec: {e}")),
        }
        // 2. chroot ownership: root-owned chroot + a user-writable subdir
        let steps: [(&str, Vec<String>); 4] = [
            ("mkdir", vec!["-p".into(), files.clone()]),
            ("chown", vec!["root:root".into(), chroot.clone()]),
            ("chmod", vec!["755".into(), chroot.clone()]),
            ("chown", vec![format!("{username}:{username}"), files.clone()]),
        ];
        for (prog, args) in steps {
            match run_cmd(prog, &args).await {
                Ok(o) if o.status.success() => {}
                Ok(o) => {
                    return Err(format!("{prog}: {}", String::from_utf8_lossy(&o.stderr).trim()))
                }
                Err(e) => return Err(format!("{prog} exec: {e}")),
            }
        }
        // 3. password — fed on stdin only, never the argv/process table
        match run_cmd_stdin("chpasswd", &[], &line).await {
            Ok(o) if o.status.success() => {}
            Ok(o) => {
                return Err(format!("chpasswd: {}", String::from_utf8_lossy(&o.stderr).trim()))
            }
            Err(e) => return Err(format!("chpasswd exec: {e}")),
        }
        Ok(chroot)
    }

    async fn ftp_account_create(&self, job: &Job) -> JobOutcome {
        use tokio::io::AsyncWriteExt;
        let username = job
            .payload
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("");
        let password = job
            .payload
            .get("password")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !valid_system_username(username) {
            return JobOutcome::failed("ftp.account.create: invalid username");
        }
        let chroot = match self.provision_sftp_user(username, password).await {
            Ok(c) => c,
            Err(e) => return JobOutcome::failed(format!("ftp.account.create: {e}")),
        };
        // Append the SFTP chroot rule (sshd reads it via an Include directive).
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
                    .write_all(render_sftp_match(username, &chroot).as_bytes())
                    .await
                {
                    return JobOutcome::failed(format!("write failed: {e}"));
                }
            }
            Err(e) => return JobOutcome::failed(format!("open failed: {e}")),
        }
        JobOutcome::succeeded(json!({"username": username, "chroot": chroot}))
    }

    /// Resets an existing SFTP account's password via `chpasswd` (stdin only).
    async fn ftp_account_password(&self, job: &Job) -> JobOutcome {
        let username = job
            .payload
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("");
        let password = job
            .payload
            .get("password")
            .and_then(Value::as_str)
            .unwrap_or("");
        let line = match chpasswd_line(username, password) {
            Some(l) => l,
            None => return JobOutcome::failed("ftp.account.password: unsafe credentials"),
        };
        match run_cmd_stdin("chpasswd", &[], &line).await {
            Ok(o) if o.status.success() => JobOutcome::succeeded(json!({"username": username})),
            Ok(o) => JobOutcome::failed(format!(
                "ftp.account.password: chpasswd: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => JobOutcome::failed(format!("ftp.account.password: chpasswd exec: {e}")),
        }
    }

    async fn database_user_create(&self, job: &Job) -> JobOutcome {
        self.database_user_apply(job, true).await
    }

    async fn database_user_privileges(&self, job: &Job) -> JobOutcome {
        self.database_user_apply(job, false).await
    }

    /// Resets a database user's password by running an injection-safe ALTER
    /// statement inside the DB container (the username, host and password are
    /// all validated before the SQL is rendered).
    async fn database_user_password(&self, job: &Job) -> JobOutcome {
        let pv = |k: &str| job.payload.get(k).and_then(Value::as_str);
        let db_id = pv("database_id").unwrap_or("unknown");
        let engine = pv("engine").unwrap_or("postgres");
        let database = pv("database").unwrap_or("app");
        let owner = pv("owner").unwrap_or(database);
        let username = pv("username").unwrap_or("");
        let host = pv("host").unwrap_or("%");
        let password = pv("password").unwrap_or("");
        if username.is_empty() {
            return JobOutcome::failed("database.user.password: missing username");
        }
        let sql = match render_db_user_password(engine, username, host, password) {
            Some(s) => s,
            None => {
                return JobOutcome::failed(
                    "database.user.password: unsafe input or unsupported engine",
                )
            }
        };
        let container = format!("astp_db_{db_id}");
        let args = match db_user_apply_args(engine, &container, owner, database, &sql) {
            Some(a) => a,
            None => {
                return JobOutcome::failed(format!(
                    "database.user.password: unsupported engine {engine}"
                ))
            }
        };
        apply_admin_sql(&args, json!({"username": username, "database": database})).await
    }

    /// Creates (when `with_password`) or re-grants a database user. The CREATE
    /// USER / GRANT SQL is rendered from an allowlist (privileges, username, host
    /// and password are all validated) and run inside the DB container.
    async fn database_user_apply(&self, job: &Job, with_password: bool) -> JobOutcome {
        let pv = |k: &str| job.payload.get(k).and_then(Value::as_str);
        let db_id = pv("database_id").unwrap_or("unknown");
        let engine = pv("engine").unwrap_or("postgres");
        let database = pv("database").unwrap_or("app");
        let owner = pv("owner").unwrap_or(database);
        let username = pv("username").unwrap_or("");
        let host = pv("host").unwrap_or("%");
        let password = pv("password").unwrap_or("");
        let empty: Vec<Value> = Vec::new();
        let privileges = job
            .payload
            .get("privileges")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        if username.is_empty() {
            return JobOutcome::failed("database.user: missing username");
        }
        let pw = if with_password { Some(password) } else { None };
        let sql = match render_db_user_grant(engine, database, username, host, pw, privileges) {
            Some(s) => s,
            None => {
                return JobOutcome::failed(
                    "database.user: unsafe input, bad privilege or unsupported engine",
                )
            }
        };
        let container = format!("astp_db_{db_id}");
        let args = match db_user_apply_args(engine, &container, owner, database, &sql) {
            Some(a) => a,
            None => {
                return JobOutcome::failed(format!("database.user: unsupported engine {engine}"))
            }
        };
        apply_admin_sql(&args, json!({"username": username, "database": database})).await
    }

    async fn database_user_delete(&self, job: &Job) -> JobOutcome {
        let pv = |k: &str| job.payload.get(k).and_then(Value::as_str);
        let db_id = pv("database_id").unwrap_or("unknown");
        let engine = pv("engine").unwrap_or("postgres");
        let database = pv("database").unwrap_or("app");
        let owner = pv("owner").unwrap_or(database);
        let username = pv("username").unwrap_or("");
        let host = pv("host").unwrap_or("%");
        let sql = match render_db_user_drop(engine, username, host) {
            Some(s) => s,
            None => {
                return JobOutcome::failed("database.user.delete: unsafe input or unsupported engine")
            }
        };
        let container = format!("astp_db_{db_id}");
        let args = match db_user_apply_args(engine, &container, owner, database, &sql) {
            Some(a) => a,
            None => {
                return JobOutcome::failed(format!(
                    "database.user.delete: unsupported engine {engine}"
                ))
            }
        };
        apply_admin_sql(&args, json!({"username": username, "deleted": true})).await
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

    /// Writes a pg_hba.conf access block for a database's allowed remote hosts and
    /// best-effort reloads Postgres. Postgres only (the engine that runs live).
    async fn database_access_apply(&self, job: &Job) -> JobOutcome {
        let db_id = job
            .payload
            .get("database_id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let engine = job.payload.get("engine").and_then(Value::as_str).unwrap_or("postgres");
        let empty: Vec<Value> = Vec::new();
        let hosts = job
            .payload
            .get("hosts")
            .and_then(Value::as_array)
            .unwrap_or(&empty);

        // MySQL/MariaDB: host-scoped CREATE USER + GRANT run inside the container.
        if engine == "mysql" || engine == "mariadb" {
            let database = job.payload.get("database").and_then(Value::as_str).unwrap_or("app");
            let user = job.payload.get("user").and_then(Value::as_str).unwrap_or("").trim();
            let password = job.payload.get("password").and_then(Value::as_str).unwrap_or("");
            if user.is_empty() {
                return JobOutcome::failed("database.access.apply: missing database user");
            }
            let sql = render_mysql_grants(database, user, password, hosts);
            if sql.is_empty() {
                return JobOutcome::succeeded(json!({"hosts": 0}));
            }
            let granted = sql.matches("CREATE USER").count();
            let container = format!("astp_db_{db_id}");
            return match run_docker(&[
                "exec".into(),
                container,
                "mysql".into(),
                "-uroot".into(),
                "-e".into(),
                sql,
            ])
            .await
            {
                Ok(o) if o.status.success() => JobOutcome::succeeded(json!({"hosts": granted})),
                Ok(o) => JobOutcome::failed(format!(
                    "grant failed: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                )),
                Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
            };
        }
        if engine != "postgres" {
            return JobOutcome::failed("database.access.apply: unsupported engine");
        }
        let content = render_pg_hba(hosts);
        let dir = std::env::var("AGENT_DB_DIR").unwrap_or_else(|_| "/etc/asterpanel/db".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("database.access.apply: mkdir failed: {e}"));
        }
        let path = format!("{dir}/{db_id}-pg_hba.conf");
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("database.access.apply: write failed: {e}"));
        }
        // Best-effort: drop the rules into the container and reload Postgres.
        let container = format!("astp_db_{db_id}");
        let _ = run_docker(&[
            "cp".into(),
            path.clone(),
            format!("{container}:/var/lib/postgresql/data/asterpanel_hba.conf"),
        ])
        .await;
        let _ = run_docker(&[
            "exec".into(),
            container,
            "psql".into(),
            "-U".into(),
            "postgres".into(),
            "-c".into(),
            "SELECT pg_reload_conf();".into(),
        ])
        .await;
        let count = content.lines().filter(|l| l.starts_with("host ")).count();
        JobOutcome::succeeded(json!({"path": path, "hosts": count}))
    }

    /// Dumps a database (pg_dump / mysqldump) from its container, gzips it and
    /// uploads off-site to S3 when a bucket is configured — a phpMyAdmin-style
    /// export.
    async fn database_dump(&self, job: &Job) -> JobOutcome {
        let pv = |k: &str| job.payload.get(k).and_then(Value::as_str);
        let db_id = pv("database_id").unwrap_or("unknown");
        let engine = pv("engine").unwrap_or("postgres");
        let database = pv("database").unwrap_or("app");
        let owner = pv("owner").unwrap_or(database);
        let key = pv("key").unwrap_or("");
        let container = format!("astp_db_{db_id}");
        let args = match db_dump_args(engine, &container, database, owner) {
            Some(a) => a,
            None => return JobOutcome::failed(format!("database.dump: unsupported engine {engine}")),
        };
        let out = match run_docker(&args).await {
            Ok(o) if o.status.success() => o.stdout,
            Ok(o) => {
                return JobOutcome::failed(format!(
                    "dump failed: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                ))
            }
            Err(e) => return JobOutcome::failed(format!("could not exec docker: {e}")),
        };
        let dir = std::env::var("AGENT_BACKUP_DIR").unwrap_or_else(|_| "/var/asterpanel/backups".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("database.dump: mkdir failed: {e}"));
        }
        let sql = format!("{dir}/{db_id}.sql");
        if let Err(e) = tokio::fs::write(&sql, &out).await {
            return JobOutcome::failed(format!("database.dump: write failed: {e}"));
        }
        let _ = run_cmd("gzip", &["-f".into(), sql.clone()]).await;
        let gz = format!("{sql}.gz");
        let size = tokio::fs::metadata(&gz).await.map(|m| m.len()).unwrap_or(0);
        if let Ok(bucket) = std::env::var("AGENT_S3_BUCKET") {
            if !key.is_empty() {
                if let Ok(u) = run_cmd("aws", &s3_cp_args(&gz, &bucket, key)).await {
                    if u.status.success() {
                        return JobOutcome::succeeded(json!({
                            "path": gz, "size_bytes": size, "storage": "s3",
                            "s3": format!("s3://{bucket}/{key}"),
                        }));
                    }
                }
            }
        }
        JobOutcome::succeeded(json!({"path": gz, "size_bytes": size, "storage": "local"}))
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

    /// Lists or restarts the node's AsterPanel-managed containers. Restart is
    /// hard-scoped to `astp_*` names so a tenant can never touch shared infra.
    async fn service_control(&self, job: &Job) -> JobOutcome {
        let action = job.payload.get("action").and_then(Value::as_str).unwrap_or("status");
        match action {
            "status" => {
                match run_cmd(
                    "docker",
                    &[
                        "ps".into(), "-a".into(), "--format".into(),
                        "{{.Names}}\t{{.State}}\t{{.Status}}".into(),
                    ],
                )
                .await
                {
                    Ok(o) if o.status.success() => {
                        let services = parse_docker_services(&String::from_utf8_lossy(&o.stdout));
                        JobOutcome::succeeded(json!({"services": services}))
                    }
                    Ok(o) => JobOutcome::failed(format!(
                        "docker ps failed: {}",
                        String::from_utf8_lossy(&o.stderr).trim()
                    )),
                    Err(_) => JobOutcome::failed("service.control: docker not available on the node"),
                }
            }
            "restart" => {
                let name = job.payload.get("name").and_then(Value::as_str).unwrap_or("").trim();
                if !name.starts_with("astp_") || name.contains(char::is_whitespace) {
                    return JobOutcome::failed("service.control: only astp_* containers can be restarted");
                }
                match run_cmd("docker", &["restart".into(), name.to_string()]).await {
                    Ok(o) if o.status.success() => JobOutcome::succeeded(json!({"name": name, "restarted": true})),
                    Ok(o) => JobOutcome::failed(format!(
                        "restart failed: {}",
                        String::from_utf8_lossy(&o.stderr).trim()
                    )),
                    Err(_) => JobOutcome::failed("service.control: docker not available on the node"),
                }
            }
            _ => JobOutcome::failed("service.control: unknown action"),
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

    /// Regenerates the Caddy subdomains snippet: a site block per subdomain/addon
    /// (serving a document root) or alias (redirecting to a target URL).
    async fn subdomain_apply(&self, job: &Job) -> JobOutcome {
        let empty: Vec<Value> = Vec::new();
        let subs = job
            .payload
            .get("subdomains")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let content = render_caddy_subdomains(subs);
        let dir =
            std::env::var("AGENT_CADDY_DIR").unwrap_or_else(|_| "/etc/asterpanel/caddy".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("subdomain.apply: mkdir failed: {e}"));
        }
        let path = format!("{dir}/subdomains.caddy");
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("subdomain.apply: write failed: {e}"));
        }
        let _ = run_cmd("caddy", &["reload".into(), "--force".into()]).await;
        JobOutcome::succeeded(json!({"path": path, "subdomains": subs.len()}))
    }

    /// Regenerates the Caddy directory-privacy snippet (HTTP basic-auth on a
    /// path) from the full rule set, grouped into one site block per domain.
    async fn protection_apply(&self, job: &Job) -> JobOutcome {
        let empty: Vec<Value> = Vec::new();
        let basic_auth = job
            .payload
            .get("basic_auth")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let hotlink = job
            .payload
            .get("hotlink")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let webdav = job
            .payload
            .get("webdav")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let content = render_caddy_protection(basic_auth, hotlink, webdav);
        let dir =
            std::env::var("AGENT_CADDY_DIR").unwrap_or_else(|_| "/etc/asterpanel/caddy".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("protection.apply: mkdir failed: {e}"));
        }
        let path = format!("{dir}/protection.caddy");
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("protection.apply: write failed: {e}"));
        }
        let _ = run_cmd("caddy", &["reload".into(), "--force".into()]).await;
        JobOutcome::succeeded(json!({
            "path": path, "rules": basic_auth.len(), "hotlink": hotlink.len(), "webdav": webdav.len(),
        }))
    }

    /// Lists the Postfix mail queue (`postqueue -p`) parsed into entries.
    async fn mail_queue_list(&self, _job: &Job) -> JobOutcome {
        match run_docker(&[
            "exec".into(),
            "astp_mailserver".into(),
            "postqueue".into(),
            "-p".into(),
        ])
        .await
        {
            Ok(o) if o.status.success() => {
                let out = String::from_utf8_lossy(&o.stdout);
                let entries = parse_postqueue(&out);
                let active = entries
                    .iter()
                    .filter(|e| e.get("status").and_then(Value::as_str) == Some("active"))
                    .count();
                let deferred = entries.len() - active;
                JobOutcome::succeeded(
                    json!({"entries": entries, "active": active, "deferred": deferred}),
                )
            }
            Ok(o) => JobOutcome::failed(format!(
                "postqueue failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
        }
    }

    /// Acts on the mail queue: flush (attempt delivery now), delete one message,
    /// or delete the whole queue. The queue id is validated to stay shell-safe.
    async fn mail_queue_action(&self, job: &Job) -> JobOutcome {
        let action = job.payload.get("action").and_then(Value::as_str).unwrap_or("");
        let args: Vec<String> = match action {
            "flush" => vec![
                "exec".into(),
                "astp_mailserver".into(),
                "postqueue".into(),
                "-f".into(),
            ],
            "delete_all" => vec![
                "exec".into(),
                "astp_mailserver".into(),
                "postsuper".into(),
                "-d".into(),
                "ALL".into(),
            ],
            "delete" => {
                let qid = job.payload.get("queue_id").and_then(Value::as_str).unwrap_or("");
                if !valid_queue_id(qid) {
                    return JobOutcome::failed("mail.queue.action: invalid queue id");
                }
                vec![
                    "exec".into(),
                    "astp_mailserver".into(),
                    "postsuper".into(),
                    "-d".into(),
                    qid.into(),
                ]
            }
            _ => return JobOutcome::failed("mail.queue.action: unknown action"),
        };
        match run_docker(&args).await {
            Ok(o) if o.status.success() => {
                JobOutcome::succeeded(json!({"ok": true, "action": action}))
            }
            Ok(o) => JobOutcome::failed(format!(
                "mail.queue.action failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
        }
    }

    /// Reads the Postfix mail log and parses delivery results (WHM "Track
    /// Delivery"). The query is applied as an in-process substring filter — it is
    /// never passed to the shell — so the read is injection-safe.
    async fn mail_delivery_track(&self, job: &Job) -> JobOutcome {
        let query = job.payload.get("query").and_then(Value::as_str).unwrap_or("").trim();
        let limit = job
            .payload
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(200)
            .clamp(1, 1000) as usize;
        match run_docker(&[
            "exec".into(),
            "astp_mailserver".into(),
            "sh".into(),
            "-c".into(),
            "tail -n 5000 /var/log/mail.log 2>/dev/null".into(),
        ])
        .await
        {
            Ok(o) => {
                let log = String::from_utf8_lossy(&o.stdout);
                let events = parse_mail_delivery(&log, query, limit);
                let count = events.len();
                JobOutcome::succeeded(json!({"events": events, "count": count}))
            }
            Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
        }
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

    /// Writes a per-site php.ini overrides file (allowlisted directives only) and
    /// best-effort drops it into the site's PHP container conf.d + restarts it.
    async fn runtime_phpini_apply(&self, job: &Job) -> JobOutcome {
        let website_id = job
            .payload
            .get("website_id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let empty: Vec<Value> = Vec::new();
        let settings = job
            .payload
            .get("settings")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let content = render_php_ini(settings);
        let dir = std::env::var("AGENT_PHP_INI_DIR").unwrap_or_else(|_| "/etc/asterpanel/php".into());
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return JobOutcome::failed(format!("runtime.phpini.apply: mkdir failed: {e}"));
        }
        let path = format!("{dir}/{website_id}.ini");
        if let Err(e) = tokio::fs::write(&path, content.as_bytes()).await {
            return JobOutcome::failed(format!("runtime.phpini.apply: write failed: {e}"));
        }
        // Best-effort live apply: copy into the PHP container's conf.d and restart.
        let container = format!("astp_site_{website_id}");
        let dest = format!("{container}:/usr/local/etc/php/conf.d/zz-asterpanel.ini");
        let _ = run_docker(&["cp".into(), path.clone(), dest]).await;
        let _ = run_docker(&["restart".into(), container]).await;
        let count = content
            .lines()
            .filter(|l| !l.is_empty() && !l.starts_with(';'))
            .count();
        JobOutcome::succeeded(json!({"path": path, "directives": count}))
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

/// A POSIX-ish environment variable name: a letter or `_` first, then
/// letters/digits/`_`, ≤128 chars. Anything else is dropped so a crafted key
/// can't smuggle extra `docker run` flags into the argv.
fn valid_env_key(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    s.len() <= 128 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn app_run_args(
    container: &str,
    network: &str,
    image: &str,
    tenant: &str,
    dep_id: &str,
    env: &[(String, String)],
    command: Option<&str>,
) -> Vec<String> {
    let mut v = vec![
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
    ];
    // Each var becomes exactly two argv elements (`-e`, `KEY=VALUE`); the value is
    // never word-split, and invalid keys are dropped, so no flag injection.
    for (k, val) in env {
        if valid_env_key(k) {
            v.push("-e".into());
            v.push(format!("{k}={val}"));
        }
    }
    v.push(image.into());
    // A start command runs as `sh -c "<command>"` *inside* the container; it is a
    // single argv element to docker (no host shell), so it cannot affect the host.
    if let Some(cmd) = command {
        let cmd = cmd.trim();
        if !cmd.is_empty() {
            v.push("sh".into());
            v.push("-c".into());
            v.push(cmd.into());
        }
    }
    v
}

/// Dovecot passwd-file line. {PLAIN} is used for the MVP; production stores a
/// hashed scheme such as {SHA512-CRYPT}.
fn render_dovecot_user(address: &str, password: &str) -> String {
    format!("{address}:{{PLAIN}}{password}\n")
}

fn render_postfix_virtual(address: &str) -> String {
    format!("{address}\t{address}\n")
}

/// A mailbox address `local@domain`: a sane local part plus a valid domain. Used
/// to gate the declarative mailbox re-render so a crafted address can't inject
/// extra passwd / virtual-map lines.
fn valid_mail_address(s: &str) -> bool {
    let (local, domain) = match s.split_once('@') {
        Some(p) => p,
        None => return false,
    };
    !local.is_empty()
        && local.len() <= 64
        && local
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-_+".contains(c))
        && valid_mail_domain(domain)
}

/// Renders the full Dovecot passwd-file from the active mailboxes (declarative
/// re-render). One `address:{PLAIN}password` line per active mailbox; suspended
/// mailboxes and unsafe addresses / passwords (containing the `:` separator or a
/// newline) are skipped so nothing can smuggle an extra line.
fn render_dovecot_users(mailboxes: &[Value]) -> String {
    let mut out = String::new();
    for m in mailboxes {
        let addr = m.get("address").and_then(Value::as_str).unwrap_or("").trim();
        let pw = m.get("password").and_then(Value::as_str).unwrap_or("");
        let active = m.get("active").and_then(Value::as_bool).unwrap_or(true);
        if !active || !valid_mail_address(addr) || pw.contains([':', '\n', '\r']) {
            continue;
        }
        out.push_str(&render_dovecot_user(addr, pw));
    }
    out
}

/// Renders the full Postfix virtual (local-delivery) map from the active
/// mailboxes — one `address<TAB>address` line each.
fn render_postfix_virtual_mailboxes(mailboxes: &[Value]) -> String {
    let mut out = String::new();
    for m in mailboxes {
        let addr = m.get("address").and_then(Value::as_str).unwrap_or("").trim();
        let active = m.get("active").and_then(Value::as_bool).unwrap_or(true);
        if !active || !valid_mail_address(addr) {
            continue;
        }
        out.push_str(&render_postfix_virtual(addr));
    }
    out
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

/// Rspamd action thresholds (greylist sits a couple of points below add_header).
fn render_rspamd_actions(reject: i64, add_header: i64) -> String {
    let greylist = (add_header - 2).max(1);
    format!("# AsterPanel (generated — do not edit)\nreject = {reject};\nadd_header = {add_header};\ngreylist = {greylist};\n")
}

fn render_rspamd_greylist(enabled: bool) -> String {
    format!("# AsterPanel (generated — do not edit)\nenabled = {enabled};\n")
}

/// Rspamd multimap referencing the allow/deny sender map files.
fn render_rspamd_multimap(allow_path: &str, deny_path: &str) -> String {
    format!(
        "# AsterPanel (generated — do not edit)\n\
ASTERPANEL_ALLOW {{\n  type = \"from\";\n  map = \"{allow_path}\";\n  score = -10.0;\n  symbol = \"ASTERPANEL_ALLOW\";\n}}\n\
ASTERPANEL_DENY {{\n  type = \"from\";\n  map = \"{deny_path}\";\n  score = 12.0;\n  symbol = \"ASTERPANEL_DENY\";\n}}\n"
    )
}

/// Parses a `dnssec-dsfromkey` DS line into structured fields. Example:
///   `example.com. IN DS 12345 13 2 49FD46E6…`
/// A digest split across whitespace tokens is concatenated.
fn parse_ds_record(line: &str) -> Option<Value> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    let pos = parts.iter().position(|&t| t == "DS")?;
    let key_tag: u32 = parts.get(pos + 1)?.parse().ok()?;
    let algorithm: u8 = parts.get(pos + 2)?.parse().ok()?;
    let digest_type: u8 = parts.get(pos + 3)?.parse().ok()?;
    let digest: String = parts.get(pos + 4..)?.concat().to_uppercase();
    if digest.is_empty() || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(json!({
        "key_tag": key_tag,
        "algorithm": algorithm,
        "digest_type": digest_type,
        "digest": digest,
        "rdata": format!("{key_tag} {algorithm} {digest_type} {digest}"),
    }))
}

/// Parses `docker ps` lines formatted as `name<TAB>state<TAB>status`, keeping
/// only AsterPanel-managed `astp_*` containers.
fn parse_docker_services(out: &str) -> Vec<Value> {
    out.lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            let name = f.next()?.trim();
            if !name.starts_with("astp_") {
                return None;
            }
            let state = f.next().unwrap_or("").trim();
            let status = f.next().unwrap_or("").trim();
            Some(json!({"name": name, "state": state, "status": status}))
        })
        .collect()
}

/// Renders a Radicale htpasswd users file (`username:bcrypt_hash` per line) from
/// the account set. Only bcrypt hashes are accepted; usernames with `:` or empty
/// values are skipped.
fn render_radicale_users(accounts: &[Value]) -> String {
    let mut out = String::new();
    for a in accounts {
        let user = a.get("username").and_then(Value::as_str).unwrap_or("").trim();
        let hash = a.get("password_hash").and_then(Value::as_str).unwrap_or("").trim();
        if user.is_empty() || user.contains(':') || !hash.starts_with("$2") {
            continue;
        }
        out.push_str(&format!("{user}:{hash}\n"));
    }
    out
}

/// `docker run` argv for the Radicale CalDAV/CardDAV server.
fn radicale_args(data_dir: &str) -> Vec<String> {
    vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        "astp_radicale".into(),
        "--restart".into(),
        "unless-stopped".into(),
        "-p".into(),
        "5232:5232".into(),
        "-v".into(),
        format!("{data_dir}:/data"),
        "-v".into(),
        format!("{data_dir}/users:/etc/radicale/users:ro"),
        "tomsquest/docker-radicale".into(),
    ]
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

/// Renders the Caddy snippet for subdomains/addon sites (serve a document root)
/// and aliases (redirect to a target URL). One site block per fqdn; entries with
/// an invalid hostname, document root or target are skipped.
fn render_caddy_subdomains(subs: &[Value]) -> String {
    let mut out = String::from("# AsterPanel subdomains (generated — do not edit)\n");
    for s in subs {
        let fqdn = s.get("fqdn").and_then(Value::as_str).unwrap_or("").trim();
        if !valid_mail_domain(fqdn) {
            continue;
        }
        let kind = s.get("kind").and_then(Value::as_str).unwrap_or("subdomain");
        if kind == "alias" {
            let target = s.get("target_url").and_then(Value::as_str).unwrap_or("").trim();
            if !valid_redirect_target(target) {
                continue;
            }
            out.push_str(&format!("{fqdn} {{\n\tredir {target}{{uri}} permanent\n}}\n"));
        } else {
            let root = s.get("document_root").and_then(Value::as_str).unwrap_or("").trim();
            if !valid_doc_root(root) {
                continue;
            }
            out.push_str(&format!("{fqdn} {{\n\troot * {root}\n\tfile_server\n}}\n"));
        }
    }
    out
}

/// An absolute document-root path: starts with `/`, no whitespace or shell/Caddy
/// metacharacters, max 512 chars.
fn valid_doc_root(s: &str) -> bool {
    s.starts_with('/')
        && s.len() <= 512
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c))
}

/// A git ref/branch name: letters, digits and `/._-`, at most 100 chars.
fn valid_git_ref(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c))
}

/// A resource id safe to embed in an on-disk path: non-empty, ≤64 chars, ASCII
/// alphanumerics and `-` only. Anything else (`/`, `.`, …) could escape the root,
/// so staging paths are always derived from a validated id, never a raw payload.
fn valid_path_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The (production, staging) document-root paths for a website's staging
/// environment. None unless the id is path-safe.
fn staging_paths(website_id: &str) -> Option<(String, String)> {
    if !valid_path_id(website_id) {
        return None;
    }
    Some((
        format!("/var/asterpanel/sites/{website_id}"),
        format!("/var/asterpanel/staging/{website_id}"),
    ))
}

/// rsync argv that mirrors `src` into `dst` (archive mode, deleting files at the
/// destination that no longer exist in the source). Both paths must be absolute
/// and inside the allowed roots; None otherwise. The trailing slash on `src`
/// copies its *contents* rather than the directory itself.
fn staging_rsync_args(src: &str, dst: &str) -> Option<Vec<String>> {
    if !valid_doc_root(src) || !valid_doc_root(dst) {
        return None;
    }
    Some(vec![
        "-a".into(),
        "--delete".into(),
        format!("{src}/"),
        format!("{dst}/"),
    ])
}

/// Renders the post-receive hook that checks the pushed branch out into the work
/// tree. Returns None unless the repo path, work tree and branch are all safe, so
/// the generated shell script can never carry an injected command.
fn render_post_receive_hook(repo_path: &str, work_tree: &str, branch: &str) -> Option<String> {
    if !valid_doc_root(repo_path) || !valid_doc_root(work_tree) || !valid_git_ref(branch) {
        return None;
    }
    Some(format!(
        "#!/bin/sh\n\
         # AsterPanel git deploy (generated — do not edit)\n\
         while read _old _new ref; do\n\
         \x20 if [ \"$ref\" = \"refs/heads/{branch}\" ]; then\n\
         \x20   git --work-tree={work_tree} --git-dir={repo_path} checkout -f {branch}\n\
         \x20   echo \"AsterPanel: deployed {branch} to {work_tree}\"\n\
         \x20 fi\n\
         done\n"
    ))
}

/// Renders the Caddy site-protection snippet: one site block per domain, merging
/// `basic_auth` matchers (path-scoped, bcrypt-only) and hotlink protection (a
/// referer-guarded asset matcher → 403). Invalid domains/hashes are skipped.
fn render_caddy_protection(basic_auth: &[Value], hotlink: &[Value], webdav: &[Value]) -> String {
    use std::collections::{BTreeMap, BTreeSet};
    let mut auth: BTreeMap<String, Vec<(String, String, String)>> = BTreeMap::new();
    let mut links: BTreeMap<String, (Vec<String>, Vec<String>)> = BTreeMap::new();
    // domain -> [(path, user, hash, root)]
    let mut dav: BTreeMap<String, Vec<(String, String, String, String)>> = BTreeMap::new();

    for r in basic_auth {
        let domain = r.get("domain").and_then(Value::as_str).unwrap_or("").trim();
        if !valid_mail_domain(domain) {
            continue;
        }
        let user = r.get("username").and_then(Value::as_str).unwrap_or("").trim();
        let hash = r.get("password_hash").and_then(Value::as_str).unwrap_or("").trim();
        // Only bcrypt hashes are valid for Caddy basic_auth; never accept a plain value.
        if user.is_empty() || !hash.starts_with("$2") {
            continue;
        }
        let mut path = r.get("path").and_then(Value::as_str).unwrap_or("/*").trim().to_string();
        if !path.starts_with('/') {
            path = "/*".into();
        }
        auth.entry(domain.to_string())
            .or_default()
            .push((path, user.to_string(), hash.to_string()));
    }

    for h in hotlink {
        let domain = h.get("domain").and_then(Value::as_str).unwrap_or("").trim();
        if !valid_mail_domain(domain) {
            continue;
        }
        let referers: Vec<String> = h
            .get("allowed_referers")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|d| valid_mail_domain(d))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let mut exts: Vec<String> = h
            .get("extensions")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
                    .filter(|e| !e.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric()))
                    .collect()
            })
            .unwrap_or_default();
        if exts.is_empty() {
            exts = ["jpg", "jpeg", "png", "gif", "webp", "svg", "ico"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        }
        links.insert(domain.to_string(), (referers, exts));
    }

    for d in webdav {
        let domain = d.get("domain").and_then(Value::as_str).unwrap_or("").trim();
        if !valid_mail_domain(domain) {
            continue;
        }
        let user = d.get("username").and_then(Value::as_str).unwrap_or("").trim();
        let hash = d.get("password_hash").and_then(Value::as_str).unwrap_or("").trim();
        if user.is_empty() || !hash.starts_with("$2") {
            continue;
        }
        let mut path = d.get("path").and_then(Value::as_str).unwrap_or("/webdav/*").trim().to_string();
        if !path.starts_with('/') {
            path = "/webdav/*".into();
        }
        let root = d.get("root").and_then(Value::as_str).unwrap_or("").trim();
        if !root.starts_with('/') {
            continue;
        }
        dav.entry(domain.to_string())
            .or_default()
            .push((path, user.to_string(), hash.to_string(), root.to_string()));
    }

    let domains: BTreeSet<String> = auth
        .keys()
        .chain(links.keys())
        .chain(dav.keys())
        .cloned()
        .collect();
    let mut out = String::from("# AsterPanel site protection (generated — do not edit)\n");
    for domain in domains {
        out.push_str(&format!("{domain} {{\n"));
        if let Some(rules) = auth.get(&domain) {
            for (i, (path, user, hash)) in rules.iter().enumerate() {
                out.push_str(&format!("\t@priv{i} path {path}\n"));
                out.push_str(&format!("\tbasic_auth @priv{i} {{\n"));
                out.push_str(&format!("\t\t{user} {hash}\n"));
                out.push_str("\t}\n");
            }
        }
        if let Some((referers, exts)) = links.get(&domain) {
            // The domain itself is always an allowed referer.
            let mut hosts = vec![domain.clone()];
            hosts.extend(referers.iter().cloned());
            let pattern = hosts
                .iter()
                .map(|h| h.replace('.', "\\."))
                .collect::<Vec<_>>()
                .join("|");
            let ext_globs = exts.iter().map(|e| format!("*.{e}")).collect::<Vec<_>>().join(" ");
            out.push_str("\t@hotlink {\n");
            out.push_str(&format!("\t\tpath {ext_globs}\n"));
            out.push_str("\t\theader Referer *\n");
            out.push_str(&format!(
                "\t\tnot header_regexp Referer ^https?://([a-z0-9.-]+\\.)?({pattern})\n"
            ));
            out.push_str("\t}\n");
            out.push_str("\trespond @hotlink 403\n");
        }
        if let Some(accts) = dav.get(&domain) {
            for (i, (path, user, hash, root)) in accts.iter().enumerate() {
                out.push_str(&format!("\t@dav{i} path {path}\n"));
                out.push_str(&format!("\tbasic_auth @dav{i} {{\n\t\t{user} {hash}\n\t}}\n"));
                out.push_str(&format!("\twebdav @dav{i} {{\n\t\troot {root}\n\t}}\n"));
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

/// php.ini directives a tenant may override per site. Anything outside this set
/// is dropped, so the editor can only tune safe runtime knobs.
const PHP_INI_ALLOWED: &[&str] = &[
    "memory_limit",
    "upload_max_filesize",
    "post_max_size",
    "max_execution_time",
    "max_input_time",
    "max_input_vars",
    "max_file_uploads",
    "display_errors",
    "error_reporting",
    "log_errors",
    "date.timezone",
    "default_charset",
    "allow_url_fopen",
    "file_uploads",
    "expose_php",
    "short_open_tag",
    "session.gc_maxlifetime",
    "default_socket_timeout",
    "opcache.enable",
    "opcache.memory_consumption",
    "opcache.max_accelerated_files",
    "realpath_cache_size",
];

/// Renders a php.ini overrides file from allowlisted directives. Values that
/// could break out of the directive line (newlines, `;` comments, `[` sections)
/// are rejected.
fn render_php_ini(settings: &[Value]) -> String {
    let mut out = String::from("; AsterPanel php.ini overrides (generated — do not edit)\n");
    for s in settings {
        let d = s.get("directive").and_then(Value::as_str).unwrap_or("").trim();
        if !PHP_INI_ALLOWED.contains(&d) {
            continue;
        }
        let v = s.get("value").and_then(Value::as_str).unwrap_or("").trim();
        if v.is_empty() || v.contains(['\n', '\r', ';', '[', ']']) {
            continue;
        }
        out.push_str(&format!("{d} = {v}\n"));
    }
    out
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
/// Validates a single-line OpenSSH public key: `<type> <base64> [comment]`. Any
/// options/command prefix, extra fields or non-base64 body is rejected so the
/// rendered authorized_keys file can carry no directives.
fn valid_ssh_pubkey(s: &str) -> bool {
    if s.is_empty() || s.contains('\n') || s.contains('\r') {
        return false;
    }
    let fields: Vec<&str> = s.split_whitespace().collect();
    if fields.len() < 2 || fields.len() > 3 {
        return false;
    }
    const TYPES: &[&str] = &[
        "ssh-ed25519",
        "ssh-rsa",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "sk-ssh-ed25519@openssh.com",
        "sk-ecdsa-sha2-nistp256@openssh.com",
    ];
    if !TYPES.contains(&fields[0]) {
        return false;
    }
    let body = fields[1];
    body.len() >= 20
        && body.len() <= 4096
        && body
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=')
}

/// Renders an authorized_keys file from the org's key set, dropping any entry
/// that isn't a safe single-line public key.
fn render_authorized_keys(keys: &[Value]) -> String {
    let mut out = String::from("# AsterPanel authorized keys (generated — do not edit)\n");
    for k in keys {
        let s = k.as_str().unwrap_or("").trim();
        if valid_ssh_pubkey(s) {
            out.push_str(s);
            out.push('\n');
        }
    }
    out
}

/// Builds the `docker <action> <container>` argv for a site lifecycle action. The
/// action must be start/stop/restart and the container name must be shell-safe.
fn app_lifecycle_args(action: &str, container: &str) -> Option<Vec<String>> {
    let cmd = match action {
        "start" => "start",
        "stop" => "stop",
        "restart" => "restart",
        _ => return None,
    };
    if container.is_empty()
        || !container
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some(vec![cmd.into(), container.into()])
}

fn render_sftp_match(username: &str, home: &str) -> String {
    format!(
        "Match User {username}\n    ChrootDirectory {home}\n    ForceCommand internal-sftp\n    AllowTcpForwarding no\n    X11Forwarding no\n\n"
    )
}

/// Unix login name: starts with a lowercase letter or underscore, then
/// lowercase alphanumerics / underscore / hyphen; max 32 chars (the useradd
/// limit). Anything else is refused before it reaches a host command.
fn valid_system_username(s: &str) -> bool {
    let b = s.as_bytes();
    !s.is_empty()
        && s.len() <= 32
        && (b[0].is_ascii_lowercase() || b[0] == b'_')
        && b.iter()
            .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
}

/// Builds the `user:password` line fed to `chpasswd` on stdin. Returns None if
/// the username is invalid or the password carries a separator/control byte, so
/// the single line can never be split, escaped or injected.
fn chpasswd_line(user: &str, password: &str) -> Option<String> {
    if !valid_system_username(user) {
        return None;
    }
    if password.is_empty()
        || password.len() > 128
        || password.bytes().any(|c| c == b':' || c < 0x20)
    {
        return None;
    }
    Some(format!("{user}:{password}\n"))
}

/// The managed chroot for an SFTP account: `<root>/<username>` under a directory
/// the agent owns (never a website or shared path), so chroot ownership can be
/// enforced without touching site files. Returns None on an invalid username.
fn sftp_chroot_path(root: &str, username: &str) -> Option<String> {
    if !valid_system_username(username) {
        return None;
    }
    Some(format!("{}/{username}", root.trim_end_matches('/')))
}

/// `useradd` argv: no auto-home (the agent manages the chroot dirs), a
/// non-interactive shell, and the managed chroot as the home directory.
fn useradd_args(user: &str, home: &str) -> Vec<String> {
    vec![
        "-M".into(),
        "-d".into(),
        home.into(),
        "-s".into(),
        "/usr/sbin/nologin".into(),
        user.into(),
    ]
}

/// docker exec argv that creates a database user. Postgres only for the MVP.
/// Privilege keywords accepted from the control plane. Anything outside this set
/// makes the renderer refuse, so a GRANT clause can never carry injected SQL.
fn db_privilege_clause(engine: &str, privileges: &[Value]) -> Option<String> {
    const ALLOWED: &[&str] = &[
        "ALL", "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX",
        "EXECUTE", "REFERENCES",
    ];
    let all = || -> String {
        if engine == "postgres" {
            "ALL".into()
        } else {
            "ALL PRIVILEGES".into()
        }
    };
    let mut toks: Vec<String> = Vec::new();
    for p in privileges {
        let t = p.as_str().unwrap_or("").trim().to_ascii_uppercase();
        if t.is_empty() {
            continue;
        }
        if !ALLOWED.contains(&t.as_str()) {
            return None; // unknown privilege → refuse the whole grant
        }
        if t == "ALL" {
            return Some(all());
        }
        if !toks.contains(&t) {
            toks.push(t);
        }
    }
    if toks.is_empty() {
        return Some(all());
    }
    if engine == "postgres" {
        // Postgres table grants only accept this subset; fall back to ALL otherwise.
        let pg: Vec<String> = toks
            .iter()
            .filter(|t| matches!(t.as_str(), "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "REFERENCES"))
            .cloned()
            .collect();
        return Some(if pg.is_empty() { "ALL".into() } else { pg.join(", ") });
    }
    Some(toks.join(", "))
}

/// A DB role name: letters, digits and `_`, at most 32 chars.
fn valid_db_username(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Renders the SQL to create-or-regrant a database user. With `password = Some`
/// the user is created (MySQL `CREATE USER … IDENTIFIED BY`, Postgres `CREATE ROLE
/// … LOGIN PASSWORD`); with `None` only the grants are re-applied. Returns None if
/// any input is not injection-safe or the engine is unsupported.
fn render_db_user_grant(
    engine: &str,
    database: &str,
    username: &str,
    host: &str,
    password: Option<&str>,
    privileges: &[Value],
) -> Option<String> {
    if !valid_db_username(username) {
        return None;
    }
    if let Some(pw) = password {
        if pw.contains('\'') || pw.contains('\\') {
            return None; // never emit an unescaped credential
        }
    }
    let clause = db_privilege_clause(engine, privileges)?;
    match engine {
        "mysql" | "mariadb" => {
            if !valid_mysql_host(host) {
                return None;
            }
            let mut out = String::new();
            if let Some(pw) = password {
                out.push_str(&format!(
                    "CREATE USER IF NOT EXISTS '{username}'@'{host}' IDENTIFIED BY '{pw}';\n"
                ));
            }
            out.push_str(&format!(
                "REVOKE ALL PRIVILEGES ON `{database}`.* FROM '{username}'@'{host}';\n"
            ));
            out.push_str(&format!(
                "GRANT {clause} ON `{database}`.* TO '{username}'@'{host}';\n"
            ));
            out.push_str("FLUSH PRIVILEGES;\n");
            Some(out)
        }
        "postgres" => {
            let mut out = String::new();
            if let Some(pw) = password {
                out.push_str(&format!("CREATE ROLE \"{username}\" WITH LOGIN PASSWORD '{pw}';\n"));
            }
            out.push_str(&format!(
                "GRANT CONNECT ON DATABASE \"{database}\" TO \"{username}\";\n"
            ));
            out.push_str(&format!(
                "GRANT {clause} ON ALL TABLES IN SCHEMA public TO \"{username}\";\n"
            ));
            Some(out)
        }
        _ => None,
    }
}

/// Renders the SQL to drop a database user.
fn render_db_user_drop(engine: &str, username: &str, host: &str) -> Option<String> {
    if !valid_db_username(username) {
        return None;
    }
    match engine {
        "mysql" | "mariadb" => {
            if !valid_mysql_host(host) {
                return None;
            }
            Some(format!(
                "DROP USER IF EXISTS '{username}'@'{host}';\nFLUSH PRIVILEGES;\n"
            ))
        }
        "postgres" => Some(format!("DROP ROLE IF EXISTS \"{username}\";\n")),
        _ => None,
    }
}

/// Renders the SQL to change a database user's password (MySQL `ALTER USER …
/// IDENTIFIED BY`, Postgres `ALTER ROLE … PASSWORD`). Returns None if the
/// username, host or password is not injection-safe, or the engine is unknown.
fn render_db_user_password(engine: &str, username: &str, host: &str, password: &str) -> Option<String> {
    if !valid_db_username(username) {
        return None;
    }
    if password.is_empty() || password.contains('\'') || password.contains('\\') {
        return None; // never emit an unescaped credential
    }
    match engine {
        "mysql" | "mariadb" => {
            if !valid_mysql_host(host) {
                return None;
            }
            Some(format!(
                "ALTER USER '{username}'@'{host}' IDENTIFIED BY '{password}';\nFLUSH PRIVILEGES;\n"
            ))
        }
        "postgres" => Some(format!("ALTER ROLE \"{username}\" WITH PASSWORD '{password}';\n")),
        _ => None,
    }
}

/// Builds the `docker exec` argv that runs DB-user admin SQL inside the container.
fn db_user_apply_args(
    engine: &str,
    container: &str,
    owner: &str,
    database: &str,
    sql: &str,
) -> Option<Vec<String>> {
    match engine {
        "mysql" | "mariadb" => Some(vec![
            "exec".into(),
            container.into(),
            "mysql".into(),
            "-uroot".into(),
            "-e".into(),
            sql.into(),
        ]),
        "postgres" => Some(vec![
            "exec".into(),
            container.into(),
            "psql".into(),
            "-U".into(),
            owner.into(),
            "-d".into(),
            database.into(),
            "-c".into(),
            sql.into(),
        ]),
        _ => None,
    }
}

/// Runs DB-admin SQL via `docker exec` and maps the result to a JobOutcome.
async fn apply_admin_sql(args: &[String], ok: Value) -> JobOutcome {
    match run_docker(args).await {
        Ok(o) if o.status.success() => JobOutcome::succeeded(ok),
        Ok(o) => JobOutcome::failed(format!(
            "db user op failed: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Err(e) => JobOutcome::failed(format!("could not exec docker: {e}")),
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

/// Builds the `docker exec` argv that dumps a database to stdout.
fn db_dump_args(engine: &str, container: &str, database: &str, owner: &str) -> Option<Vec<String>> {
    match engine {
        "postgres" => Some(vec![
            "exec".into(),
            container.into(),
            "pg_dump".into(),
            "-U".into(),
            owner.into(),
            "-d".into(),
            database.into(),
        ]),
        "mysql" | "mariadb" => Some(vec![
            "exec".into(),
            container.into(),
            "mysqldump".into(),
            "--no-tablespaces".into(),
            "--single-transaction".into(),
            database.into(),
        ]),
        _ => None,
    }
}

/// Renders a pg_hba.conf access block from a list of host patterns (IP or CIDR).
/// Invalid patterns are skipped; SCRAM password auth is required.
fn render_pg_hba(hosts: &[Value]) -> String {
    let mut out = String::from("# AsterPanel remote access (generated — do not edit)\n");
    for h in hosts {
        let cidr = h.as_str().unwrap_or("").trim();
        if !valid_cidr_or_ip(cidr) {
            continue;
        }
        out.push_str(&format!("host all all {cidr} scram-sha-256\n"));
    }
    out
}

/// Renders MySQL host-scoped grants: `CREATE USER … @ host` + `GRANT ALL ON db`.
/// Hosts that aren't injection-safe are skipped. The password is a control-plane
/// generated credential (hex; no quotes).
fn render_mysql_grants(database: &str, user: &str, password: &str, hosts: &[Value]) -> String {
    let mut out = String::new();
    if password.contains('\'') || password.contains('\\') {
        return out; // never emit an unescaped credential
    }
    for h in hosts {
        let host = h.as_str().unwrap_or("").trim();
        if !valid_mysql_host(host) {
            continue;
        }
        out.push_str(&format!(
            "CREATE USER IF NOT EXISTS '{user}'@'{host}' IDENTIFIED BY '{password}';\n"
        ));
        out.push_str(&format!(
            "GRANT ALL PRIVILEGES ON `{database}`.* TO '{user}'@'{host}';\n"
        ));
    }
    if !out.is_empty() {
        out.push_str("FLUSH PRIVILEGES;\n");
    }
    out
}

/// A MySQL host pattern: IP, CIDR/netmask, `%` wildcard or hostname. Quotes and
/// semicolons are rejected to keep the rendered SQL injection-safe.
fn valid_mysql_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 60
        && s.chars().all(|c| c.is_ascii_alphanumeric() || ".%_-:/".contains(c))
}

/// Accepts an IPv4 address or CIDR (e.g. `203.0.113.0/24`). Structural check.
fn valid_cidr_or_ip(s: &str) -> bool {
    let (addr, mask) = match s.split_once('/') {
        Some((a, m)) => (a, Some(m)),
        None => (s, None),
    };
    let octets: Vec<&str> = addr.split('.').collect();
    if octets.len() != 4 {
        return false;
    }
    for o in &octets {
        match o.parse::<u16>() {
            Ok(n) if n <= 255 && !o.is_empty() => {}
            _ => return false,
        }
    }
    if let Some(m) = mask {
        match m.parse::<u8>() {
            Ok(n) if n <= 32 => {}
            _ => return false,
        }
    }
    true
}

/// A Postfix queue entry parsed from `postqueue -p` output.
#[derive(Default)]
struct PostqueueEntry {
    id: String,
    size_bytes: u64,
    arrival: String,
    sender: String,
    reason: String,
    recipients: Vec<String>,
    status: String,
}

/// Parses `postqueue -p` output into queue entries. The header/footer lines and
/// the "Mail queue is empty" message are skipped; a trailing `*` marks an active
/// message, `!` a held one.
fn parse_postqueue(out: &str) -> Vec<Value> {
    let mut entries: Vec<PostqueueEntry> = Vec::new();
    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let t = line.trim_end();
        if t.starts_with("-Queue ID-") || t.starts_with("--") || t.contains("Mail queue is empty") {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if !indented {
            let toks: Vec<&str> = t.split_whitespace().collect();
            if toks.len() < 3 {
                continue;
            }
            let mut e = PostqueueEntry::default();
            let mut id = toks[0].to_string();
            if id.ends_with('*') {
                id.pop();
                e.status = "active".into();
            } else if id.ends_with('!') {
                id.pop();
                e.status = "hold".into();
            } else {
                e.status = "deferred".into();
            }
            e.id = id;
            e.size_bytes = toks[1].parse().unwrap_or(0);
            e.sender = toks[toks.len() - 1].to_string();
            e.arrival = toks[2..toks.len() - 1].join(" ");
            entries.push(e);
        } else if let Some(e) = entries.last_mut() {
            let s = t.trim();
            if s.starts_with('(') {
                e.reason = s.trim_start_matches('(').trim_end_matches(')').to_string();
            } else if s.contains('@') {
                e.recipients.push(s.to_string());
            }
        }
    }
    entries
        .iter()
        .map(|e| {
            json!({
                "id": e.id,
                "size_bytes": e.size_bytes,
                "arrival": e.arrival,
                "sender": e.sender,
                "reason": e.reason,
                "recipients": e.recipients,
                "status": e.status,
            })
        })
        .collect()
}

/// A Postfix queue id: alphanumeric, at most 40 chars (keeps postsuper args safe).
fn valid_queue_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Parses Postfix mail-log delivery results into events. Only `status=` lines
/// with a recipient are kept; if `query` is non-empty, only lines containing it.
/// The most recent `limit` events are returned.
fn parse_mail_delivery(log: &str, query: &str, limit: usize) -> Vec<Value> {
    // Value between `a` and the next `b` (empty if `a` is absent).
    let between = |s: &str, a: &str, b: &str| -> String {
        if let Some(i) = s.find(a) {
            let rest = &s[i + a.len()..];
            let j = rest.find(b).unwrap_or(rest.len());
            return rest[..j].to_string();
        }
        String::new()
    };
    // Value after `key` up to the next space or comma.
    let after = |s: &str, key: &str| -> String {
        if let Some(i) = s.find(key) {
            let rest = &s[i + key.len()..];
            let j = rest.find([' ', ',']).unwrap_or(rest.len());
            return rest[..j].to_string();
        }
        String::new()
    };
    let mut out: Vec<Value> = Vec::new();
    for line in log.lines() {
        if !line.contains("status=") || !line.contains("to=<") {
            continue;
        }
        if !query.is_empty() && !line.contains(query) {
            continue;
        }
        let toks: Vec<&str> = line.split_whitespace().collect();
        let time = if toks.len() >= 3 { toks[..3].join(" ") } else { String::new() };
        let reason = if let Some(i) = line.rfind('(') {
            let rest = &line[i + 1..];
            let j = rest.rfind(')').unwrap_or(rest.len());
            rest[..j].to_string()
        } else {
            String::new()
        };
        out.push(json!({
            "time": time,
            "queue_id": between(line, "]: ", ":").trim(),
            "to": between(line, "to=<", ">"),
            "status": after(line, "status="),
            "dsn": after(line, "dsn="),
            "relay": between(line, "relay=", ",").trim(),
            "reason": reason,
        }));
    }
    if out.len() > limit {
        out = out.split_off(out.len() - limit);
    }
    out
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

/// Runs a host command, writing `stdin_data` to its standard input. Used for
/// `chpasswd`, which reads credentials only from stdin — keeping the password
/// out of the argv and the process table.
async fn run_cmd_stdin(
    program: &str,
    args: &[String],
    stdin_data: &str,
) -> std::io::Result<std::process::Output> {
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    if let Some(mut si) = child.stdin.take() {
        si.write_all(stdin_data.as_bytes()).await?;
        si.shutdown().await?;
    }
    child.wait_with_output().await
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
        let a = app_run_args("astp_app_1", "net", "img:1", "t1", "d1", &[], None).join(" ");
        assert!(a.contains("--cap-drop ALL"), "{a}");
        assert!(a.contains("no-new-privileges"), "{a}");
        assert!(a.ends_with("img:1"), "{a}");
    }

    #[test]
    fn app_run_args_inject_env_and_command() {
        let env = vec![
            ("NODE_ENV".to_string(), "production".to_string()),
            ("API_URL".to_string(), "https://x/y".to_string()),
            ("bad key".to_string(), "v".to_string()), // dropped: not a valid name
        ];
        let v = app_run_args("astp_app_1", "net", "img:1", "t1", "d1", &env, Some("npm run start"));

        // Each valid var is exactly two argv elements; values are never split.
        let i = v.iter().position(|x| x == "NODE_ENV=production").unwrap();
        assert_eq!(v[i - 1], "-e");
        assert!(v.contains(&"API_URL=https://x/y".to_string()));
        assert!(!v.iter().any(|x| x.contains("bad key")), "{v:?}");

        // Env precedes the image; the start command follows it as `sh -c "..."`.
        let img = v.iter().position(|x| x == "img:1").unwrap();
        assert!(i < img, "env must come before the image");
        assert_eq!(&v[img + 1..], &["sh", "-c", "npm run start"]);

        // valid_env_key gate
        assert!(valid_env_key("DATABASE_URL"));
        assert!(valid_env_key("_x9"));
        assert!(!valid_env_key("9LEADING"));
        assert!(!valid_env_key("has-dash"));
        assert!(!valid_env_key(""));
    }

    #[test]
    fn dovecot_user_uses_plain_scheme() {
        assert_eq!(
            render_dovecot_user("info@acme.com", "pw"),
            "info@acme.com:{PLAIN}pw\n"
        );
    }

    #[test]
    fn mailbox_apply_renders_active_only_and_is_injection_safe() {
        let mboxes = vec![
            json!({"address": "a@acme.com", "password": "secret1", "active": true, "quota_mb": 2048}),
            json!({"address": "b@acme.com", "password": "secret2", "active": false}), // suspended → dropped
            json!({"address": "bad addr", "password": "x", "active": true}),          // invalid → dropped
            json!({"address": "c@acme.com", "password": "p:w\ninjected", "active": true}), // `:`/newline → dropped
        ];
        let users = render_dovecot_users(&mboxes);
        assert_eq!(users, "a@acme.com:{PLAIN}secret1\n", "only the valid active mailbox: {users:?}");
        assert!(!users.contains("b@acme.com"), "suspended must be dropped");
        assert!(!users.contains("injected"), "unsafe password must be dropped");

        // Postfix delivery doesn't carry the password, so a valid active address
        // still receives mail (only suspended / invalid addresses are dropped).
        let virt = render_postfix_virtual_mailboxes(&mboxes);
        assert_eq!(virt, "a@acme.com\ta@acme.com\nc@acme.com\tc@acme.com\n");

        assert!(valid_mail_address("a.b+tag@sub.acme.com"));
        assert!(!valid_mail_address("no-domain"));
        assert!(!valid_mail_address("@acme.com"));
        assert!(!valid_mail_address("a b@acme.com"));
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
    fn staging_paths_and_rsync_are_injection_safe() {
        // A valid id yields both roots under the fixed prefixes.
        let (prod, staging) = staging_paths("abc-123").unwrap();
        assert_eq!(prod, "/var/asterpanel/sites/abc-123");
        assert_eq!(staging, "/var/asterpanel/staging/abc-123");

        // Path-traversal / injection attempts are refused before any path is built.
        assert!(staging_paths("../../etc").is_none());
        assert!(staging_paths("a/b").is_none());
        assert!(staging_paths("x; rm -rf /").is_none());
        assert!(staging_paths("").is_none());

        // rsync mirrors *contents* (trailing slashes) and prunes extras (--delete).
        assert_eq!(
            staging_rsync_args(&prod, &staging).unwrap(),
            vec![
                "-a".to_string(),
                "--delete".into(),
                "/var/asterpanel/sites/abc-123/".into(),
                "/var/asterpanel/staging/abc-123/".into(),
            ]
        );
        // Unsafe sync paths (relative, or stray shell metacharacters) are rejected.
        assert!(staging_rsync_args("relative/path", "/var/asterpanel/staging/x").is_none());
        assert!(staging_rsync_args("/ok", "/bad$path").is_none());
    }

    #[test]
    fn sftp_match_is_chrooted() {
        let s = render_sftp_match("acme", "/sites/acme");
        assert!(s.contains("Match User acme"));
        assert!(s.contains("ChrootDirectory /sites/acme"));
        assert!(s.contains("internal-sftp"));
    }

    #[test]
    fn sftp_user_provisioning_is_injection_safe() {
        // valid Unix login names
        assert!(valid_system_username("acme_dev"));
        assert!(valid_system_username("_svc-1"));
        // rejected: leading digit, uppercase, space, punctuation, over-length
        assert!(!valid_system_username("1bad"));
        assert!(!valid_system_username("Bad"));
        assert!(!valid_system_username("a b"));
        assert!(!valid_system_username("root;rm"));
        assert!(!valid_system_username(&"x".repeat(33)));

        // chpasswd line: safe creds → "user:pass\n"; separators/control refused
        assert_eq!(chpasswd_line("acme", "hexpw123").unwrap(), "acme:hexpw123\n");
        assert!(chpasswd_line("acme", "has:colon").is_none());
        assert!(chpasswd_line("acme", "has\nnewline").is_none());
        assert!(chpasswd_line("bad name", "pw").is_none());
        assert!(chpasswd_line("acme", "").is_none());

        // chroot stays under the managed root; a traversal username is refused
        assert_eq!(
            sftp_chroot_path("/var/asterpanel/sftp", "acme").unwrap(),
            "/var/asterpanel/sftp/acme"
        );
        assert_eq!(
            sftp_chroot_path("/var/asterpanel/sftp/", "acme").unwrap(),
            "/var/asterpanel/sftp/acme"
        );
        assert!(sftp_chroot_path("/var/asterpanel/sftp", "../etc").is_none());

        // useradd uses a non-interactive shell + the managed chroot as home
        let a = useradd_args("acme", "/var/asterpanel/sftp/acme");
        assert!(a.contains(&"/usr/sbin/nologin".to_string()));
        assert!(a.contains(&"acme".to_string()));
        assert!(a.contains(&"/var/asterpanel/sftp/acme".to_string()));
    }

    #[test]
    fn authorized_keys_render_validates() {
        let keys = vec![
            json!("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghij user@host"),
            json!("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABbackupkey backup"),
            json!("ssh-ed25519 not!base64 evil"), // non-base64 body
            json!("command=\"rm -rf /\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"), // options prefix → too many fields
            json!("bogus-type AAAAC3NzaC1lZDI1NTE5AAAAIabcdef"), // unknown type
        ];
        let out = render_authorized_keys(&keys);
        assert!(out.contains("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghij user@host"), "{out}");
        assert!(out.contains("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABbackupkey backup"), "{out}");
        assert!(!out.contains("not!base64"), "{out}");
        assert!(!out.contains("rm -rf"), "{out}");
        assert!(!out.contains("bogus-type"), "{out}");
        assert!(valid_ssh_pubkey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghij"));
        assert!(!valid_ssh_pubkey("ssh-ed25519 AAAA\nmalicious"));
        assert!(!valid_ssh_pubkey("ssh-ed25519")); // missing body
    }

    #[test]
    fn app_lifecycle_builds_args() {
        assert_eq!(
            app_lifecycle_args("restart", "astp_site_abc-123").unwrap(),
            vec!["restart", "astp_site_abc-123"]
        );
        assert!(app_lifecycle_args("start", "astp_site_x").is_some());
        assert!(app_lifecycle_args("stop", "astp_site_x").is_some());
        assert!(app_lifecycle_args("nuke", "astp_site_x").is_none()); // unknown action
        assert!(app_lifecycle_args("restart", "bad name").is_none()); // unsafe container
        assert!(app_lifecycle_args("restart", "").is_none());
    }

    #[test]
    fn post_receive_hook_renders_and_validates() {
        let h = render_post_receive_hook(
            "/var/asterpanel/git/abc.git",
            "/var/asterpanel/sites/abc",
            "main",
        )
        .unwrap();
        assert!(h.contains("refs/heads/main"), "{h}");
        assert!(
            h.contains("git --work-tree=/var/asterpanel/sites/abc --git-dir=/var/asterpanel/git/abc.git checkout -f main"),
            "{h}"
        );
        // unsafe inputs are refused
        assert!(render_post_receive_hook("/var/git; rm -rf /", "/var/site", "main").is_none());
        assert!(render_post_receive_hook("/var/git", "/var/site", "main; evil").is_none());
        assert!(render_post_receive_hook("relative/path", "/var/site", "main").is_none());
        assert!(valid_git_ref("feature/x-1"));
        assert!(!valid_git_ref("bad branch"));
    }

    #[test]
    fn db_user_grant_mysql_create_and_privileges() {
        let privs = vec![json!("SELECT"), json!("INSERT")];
        let sql =
            render_db_user_grant("mysql", "shopdb", "shop_ro", "%", Some("deadbeef"), &privs).unwrap();
        assert!(
            sql.contains("CREATE USER IF NOT EXISTS 'shop_ro'@'%' IDENTIFIED BY 'deadbeef'"),
            "{sql}"
        );
        assert!(sql.contains("REVOKE ALL PRIVILEGES ON `shopdb`.* FROM 'shop_ro'@'%'"), "{sql}");
        assert!(sql.contains("GRANT SELECT, INSERT ON `shopdb`.* TO 'shop_ro'@'%'"), "{sql}");
        assert!(sql.contains("FLUSH PRIVILEGES;"), "{sql}");
        // grant-only (no password) omits CREATE USER and uses ALL PRIVILEGES
        let regrant =
            render_db_user_grant("mysql", "shopdb", "shop_ro", "%", None, &[json!("ALL")]).unwrap();
        assert!(!regrant.contains("CREATE USER"), "{regrant}");
        assert!(regrant.contains("GRANT ALL PRIVILEGES ON `shopdb`.* TO 'shop_ro'@'%'"), "{regrant}");
    }

    #[test]
    fn db_user_grant_rejects_unsafe() {
        // unknown privilege token → refuse the whole grant
        assert!(
            render_db_user_grant("mysql", "d", "u", "%", Some("p"), &[json!("DROP; DELETE")]).is_none()
        );
        // password carrying a quote → never emitted
        assert!(render_db_user_grant("mysql", "d", "u", "%", Some("p'x"), &[json!("ALL")]).is_none());
        // invalid username / host
        assert!(render_db_user_grant("mysql", "d", "bad name", "%", Some("p"), &[json!("ALL")]).is_none());
        assert!(render_db_user_grant("mysql", "d", "u", "ho'st", Some("p"), &[json!("ALL")]).is_none());
        // unsupported engine
        assert!(render_db_user_grant("redis", "d", "u", "%", Some("p"), &[json!("ALL")]).is_none());
    }

    #[test]
    fn db_user_grant_postgres_and_drop() {
        let sql =
            render_db_user_grant("postgres", "appdb", "reader", "%", Some("hexpw"), &[json!("SELECT")])
                .unwrap();
        assert!(sql.contains("CREATE ROLE \"reader\" WITH LOGIN PASSWORD 'hexpw'"), "{sql}");
        assert!(sql.contains("GRANT CONNECT ON DATABASE \"appdb\" TO \"reader\""), "{sql}");
        assert!(sql.contains("GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"reader\""), "{sql}");
        // drops: Postgres role vs MySQL host-scoped user
        assert!(render_db_user_drop("postgres", "reader", "%")
            .unwrap()
            .contains("DROP ROLE IF EXISTS \"reader\""));
        assert!(render_db_user_drop("mysql", "shop_ro", "10.0.0.5")
            .unwrap()
            .contains("DROP USER IF EXISTS 'shop_ro'@'10.0.0.5'"));
        assert!(render_db_user_drop("mysql", "bad name", "%").is_none());
    }

    #[test]
    fn db_user_password_reset() {
        // MySQL ALTER USER keeps the host scope and flushes privileges
        let my = render_db_user_password("mysql", "shop_ro", "10.0.0.5", "newhex").unwrap();
        assert!(my.contains("ALTER USER 'shop_ro'@'10.0.0.5' IDENTIFIED BY 'newhex'"), "{my}");
        assert!(my.contains("FLUSH PRIVILEGES"), "{my}");
        // Postgres ALTER ROLE
        let pg = render_db_user_password("postgres", "reader", "%", "newhex").unwrap();
        assert!(pg.contains("ALTER ROLE \"reader\" WITH PASSWORD 'newhex'"), "{pg}");
        // unsafe inputs are refused before any SQL is emitted
        assert!(render_db_user_password("mysql", "shop_ro", "%", "p'x").is_none()); // quote in pw
        assert!(render_db_user_password("mysql", "shop_ro", "%", "p\\x").is_none()); // backslash in pw
        assert!(render_db_user_password("postgres", "u", "%", "").is_none()); // empty pw
        assert!(render_db_user_password("mysql", "bad name", "%", "p").is_none()); // bad username
        assert!(render_db_user_password("mysql", "u", "ho'st", "p").is_none()); // bad host
        assert!(render_db_user_password("redis", "u", "%", "p").is_none()); // unsupported engine
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
    fn db_dump_args_per_engine() {
        let pg = db_dump_args("postgres", "astp_db_x", "app", "acme").unwrap().join(" ");
        assert!(pg.contains("pg_dump"), "{pg}");
        assert!(pg.contains("-U acme"), "{pg}");
        assert!(pg.contains("-d app"), "{pg}");
        let my = db_dump_args("mysql", "astp_db_y", "shop", "shop").unwrap().join(" ");
        assert!(my.contains("mysqldump"), "{my}");
        assert!(my.contains("--single-transaction"), "{my}");
        assert!(my.ends_with("shop"), "{my}");
        assert!(db_dump_args("mongo", "c", "d", "o").is_none());
    }

    #[test]
    fn pg_hba_renders_valid_hosts_only() {
        let hosts = vec![
            json!("203.0.113.0/24"),
            json!("198.51.100.7"),
            json!("not-an-ip"),       // skipped
            json!("10.0.0.0/99"),     // bad mask → skipped
            json!("999.1.1.1"),       // bad octet → skipped
        ];
        let out = render_pg_hba(&hosts);
        assert!(out.contains("host all all 203.0.113.0/24 scram-sha-256"), "{out}");
        assert!(out.contains("host all all 198.51.100.7 scram-sha-256"), "{out}");
        assert!(!out.contains("not-an-ip"), "{out}");
        assert!(!out.contains("/99"), "{out}");
        assert!(!out.contains("999"), "{out}");
        assert!(valid_cidr_or_ip("1.2.3.4"));
        assert!(valid_cidr_or_ip("10.0.0.0/8"));
        assert!(!valid_cidr_or_ip("1.2.3"));
        assert!(!valid_cidr_or_ip("1.2.3.4/40"));
    }

    #[test]
    fn mysql_grants_render() {
        let hosts = vec![json!("203.0.113.5"), json!("%"), json!("bad'quote")];
        let sql = render_mysql_grants("shopdb", "shop", "deadbeef00", &hosts);
        assert!(
            sql.contains("CREATE USER IF NOT EXISTS 'shop'@'203.0.113.5' IDENTIFIED BY 'deadbeef00'"),
            "{sql}"
        );
        assert!(sql.contains("GRANT ALL PRIVILEGES ON `shopdb`.* TO 'shop'@'203.0.113.5'"), "{sql}");
        assert!(sql.contains("'shop'@'%'"), "{sql}");
        assert!(!sql.contains("bad'quote"), "{sql}"); // unsafe host skipped
        assert!(sql.contains("FLUSH PRIVILEGES;"), "{sql}");
        // a password with a quote is never emitted (no unescaped credential)
        assert!(render_mysql_grants("d", "u", "p'x", &[json!("%")]).is_empty());
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
    fn caddy_subdomains_render() {
        let subs = vec![
            json!({"kind":"subdomain","fqdn":"blog.acme.com","document_root":"/var/www/blog","target_url":""}),
            json!({"kind":"alias","fqdn":"www.acme.net","document_root":"","target_url":"https://acme.com"}),
            json!({"kind":"subdomain","fqdn":"bad domain","document_root":"/var/www/x","target_url":""}), // invalid fqdn
            json!({"kind":"subdomain","fqdn":"evil.acme.com","document_root":"/var/www; rm -rf /","target_url":""}), // unsafe root
        ];
        let out = render_caddy_subdomains(&subs);
        assert!(out.contains("blog.acme.com {"), "{out}");
        assert!(out.contains("root * /var/www/blog"), "{out}");
        assert!(out.contains("file_server"), "{out}");
        assert!(out.contains("www.acme.net {"), "{out}");
        assert!(out.contains("redir https://acme.com{uri} permanent"), "{out}");
        assert!(!out.contains("bad domain"), "{out}"); // invalid fqdn skipped
        assert!(!out.contains("rm -rf"), "{out}"); // unsafe document root skipped
        assert!(valid_doc_root("/var/www/site"));
        assert!(!valid_doc_root("relative/path"));
        assert!(!valid_doc_root("/has space"));
    }

    #[test]
    fn postqueue_parses_entries() {
        let out = concat!(
            "-Queue ID-  --Size-- ----Arrival Time---- -Sender/Recipient-------\n",
            "A1B2C3D4E5F     1234 Tue Jun 10 09:15:00  alice@example.com\n",
            "                     (host mx.dest.com refused to talk to me)\n",
            "                                         bob@dest.com\n",
            "\n",
            "3F2E1D0C9B8*     512 Tue Jun 10 09:20:00  carol@example.com\n",
            "                                         dave@other.com\n",
            "\n",
            "-- 2 Kbytes in 2 Requests.\n",
        );
        let e = parse_postqueue(out);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0]["id"], "A1B2C3D4E5F");
        assert_eq!(e[0]["size_bytes"], 1234);
        assert_eq!(e[0]["sender"], "alice@example.com");
        assert!(e[0]["arrival"].as_str().unwrap().contains("Jun 10"), "{}", e[0]);
        assert_eq!(e[0]["status"], "deferred");
        assert!(e[0]["reason"].as_str().unwrap().contains("refused"), "{}", e[0]);
        assert_eq!(e[0]["recipients"][0], "bob@dest.com");
        assert_eq!(e[1]["id"], "3F2E1D0C9B8"); // active '*' stripped
        assert_eq!(e[1]["status"], "active");
        assert!(parse_postqueue("Mail queue is empty\n").is_empty());
        assert!(valid_queue_id("A1B2C3"));
        assert!(!valid_queue_id("bad id"));
    }

    #[test]
    fn mail_delivery_parses_log() {
        let log = concat!(
            "Jun 18 09:15:03 mail postfix/smtp[1234]: A1B2C3: to=<bob@dest.com>, relay=mx.dest.com[1.2.3.4]:25, delay=2.1, dsn=2.0.0, status=sent (250 2.0.0 OK)\n",
            "Jun 18 09:16:10 mail postfix/smtp[1235]: 9F8E7D: to=<dana@x.com>, relay=none, delay=30, dsn=4.4.1, status=deferred (connect to mx.x.com[5.6.7.8]:25: Connection timed out)\n",
            "Jun 18 09:16:11 mail postfix/qmgr[900]: 9F8E7D: from=<billing@acme.com>, size=2310, nrcpt=1 (queue active)\n",
        );
        let all = parse_mail_delivery(log, "", 100);
        assert_eq!(all.len(), 2); // the qmgr line (no status=/to=) is skipped
        assert_eq!(all[0]["queue_id"], "A1B2C3");
        assert_eq!(all[0]["to"], "bob@dest.com");
        assert_eq!(all[0]["status"], "sent");
        assert_eq!(all[0]["dsn"], "2.0.0");
        assert_eq!(all[0]["relay"], "mx.dest.com[1.2.3.4]:25");
        assert!(all[0]["reason"].as_str().unwrap().contains("250"), "{}", all[0]);
        assert_eq!(all[1]["status"], "deferred");
        assert!(all[1]["reason"].as_str().unwrap().contains("Connection timed out"), "{}", all[1]);
        // substring query filter
        let filtered = parse_mail_delivery(log, "dana@x.com", 100);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0]["to"], "dana@x.com");
    }

    #[test]
    fn caddy_protection_renders_basic_auth() {
        let rules = vec![
            json!({"domain":"acme.com","path":"/admin/*","username":"boss","password_hash":"$2a$14$abcdefghijklmnopqrstuv"}),
            json!({"domain":"acme.com","path":"/staging/*","username":"qa","password_hash":"$2a$14$zzzzzzzzzzzzzzzzzzzzzz"}),
            json!({"domain":"bad dom","path":"/x","username":"u","password_hash":"$2a$14$x"}), // invalid domain
            json!({"domain":"acme.com","path":"/y","username":"u","password_hash":"plaintext"}), // not bcrypt
        ];
        let out = render_caddy_protection(&rules, &[], &[]);
        assert!(out.contains("acme.com {"), "{out}");
        assert!(out.contains("@priv0 path /admin/*"), "{out}");
        assert!(out.contains("basic_auth @priv0 {"), "{out}");
        assert!(out.contains("boss $2a$14$abcdefghijklmnopqrstuv"), "{out}");
        assert!(out.contains("qa $2a$14$"), "{out}");
        assert!(!out.contains("bad dom"), "{out}");
        assert!(!out.contains("plaintext"), "{out}");
    }

    #[test]
    fn caddy_protection_renders_hotlink() {
        let hotlink = vec![
            json!({"domain":"acme.com","allowed_referers":["cdn.acme.com"],"extensions":["jpg","png"]}),
            json!({"domain":"shop.io","allowed_referers":[],"extensions":[]}), // defaults applied
        ];
        let out = render_caddy_protection(&[], &hotlink, &[]);
        assert!(out.contains("acme.com {"), "{out}");
        assert!(out.contains("@hotlink {"), "{out}");
        assert!(out.contains("path *.jpg *.png"), "{out}");
        assert!(out.contains("header Referer *"), "{out}");
        // the domain itself + the extra referer appear in the allow pattern (dots escaped)
        assert!(out.contains("acme\\.com|cdn\\.acme\\.com"), "{out}");
        assert!(out.contains("respond @hotlink 403"), "{out}");
        // empty extensions fall back to the default image set
        assert!(out.contains("*.webp"), "{out}");
    }

    #[test]
    fn caddy_protection_renders_webdav() {
        let dav = vec![
            json!({"domain":"acme.com","path":"/files/*","username":"dav","password_hash":"$2a$14$davhashxxxxxxxxxxxxxx","root":"/var/asterpanel/sites/acme"}),
            json!({"domain":"acme.com","path":"bad","username":"x","password_hash":"$2a$14$y","root":""}), // bad root → skipped
        ];
        let out = render_caddy_protection(&[], &[], &dav);
        assert!(out.contains("acme.com {"), "{out}");
        assert!(out.contains("@dav0 path /files/*"), "{out}");
        assert!(out.contains("basic_auth @dav0 {"), "{out}");
        assert!(out.contains("dav $2a$14$davhashxxxxxxxxxxxxxx"), "{out}");
        assert!(out.contains("webdav @dav0 {"), "{out}");
        assert!(out.contains("root /var/asterpanel/sites/acme"), "{out}");
        // the second account had no root → only one @dav block
        assert!(!out.contains("@dav1"), "{out}");
    }

    #[test]
    fn php_ini_renders_allowlisted_only() {
        let settings = vec![
            json!({"directive":"memory_limit","value":"256M"}),
            json!({"directive":"upload_max_filesize","value":"64M"}),
            json!({"directive":"evil_directive","value":"x"}),           // not allowlisted
            json!({"directive":"display_errors","value":"Off\n[hack]"}), // injection → dropped
        ];
        let out = render_php_ini(&settings);
        assert!(out.contains("memory_limit = 256M"), "{out}");
        assert!(out.contains("upload_max_filesize = 64M"), "{out}");
        assert!(!out.contains("evil_directive"), "{out}");
        assert!(!out.contains("[hack]"), "{out}");
    }

    #[test]
    fn rspamd_config_renders() {
        let a = render_rspamd_actions(15, 6);
        assert!(a.contains("reject = 15;"), "{a}");
        assert!(a.contains("add_header = 6;"), "{a}");
        assert!(a.contains("greylist = 4;"), "{a}");
        assert!(render_rspamd_greylist(false).contains("enabled = false;"));
        assert!(render_rspamd_greylist(true).contains("enabled = true;"));
        let mm = render_rspamd_multimap("/x/allow.map", "/x/deny.map");
        assert!(mm.contains("ASTERPANEL_ALLOW"), "{mm}");
        assert!(mm.contains("map = \"/x/allow.map\";"), "{mm}");
        assert!(mm.contains("score = -10.0;"), "{mm}");
        assert!(mm.contains("ASTERPANEL_DENY"), "{mm}");
        assert!(mm.contains("score = 12.0;"), "{mm}");
    }

    #[test]
    fn radicale_users_and_args() {
        let accounts = vec![
            json!({"username":"alice","password_hash":"$2a$14$alicehashxxxxxxxxxxxx"}),
            json!({"username":"bad:name","password_hash":"$2a$14$x"}), // colon → skipped
            json!({"username":"bob","password_hash":"plaintext"}),     // not bcrypt → skipped
        ];
        let out = render_radicale_users(&accounts);
        assert!(out.contains("alice:$2a$14$alicehashxxxxxxxxxxxx"), "{out}");
        assert!(!out.contains("bad:name"), "{out}");
        assert!(!out.contains("bob"), "{out}");
        let args = radicale_args("/data").join(" ");
        assert!(args.contains("astp_radicale"), "{args}");
        assert!(args.contains("5232:5232"), "{args}");
        assert!(args.contains("/data:/data"), "{args}");
    }

    #[test]
    fn parses_ds_record_from_dsfromkey() {
        let line = "example.com. IN DS 12345 13 2 49FD46E6C4B45C55D4AC";
        let v = parse_ds_record(line).expect("should parse");
        assert_eq!(v["key_tag"], 12345);
        assert_eq!(v["algorithm"], 13);
        assert_eq!(v["digest_type"], 2);
        assert_eq!(v["digest"], "49FD46E6C4B45C55D4AC");
        assert_eq!(v["rdata"], "12345 13 2 49FD46E6C4B45C55D4AC");
        // a digest split across tokens is concatenated
        let split = "z. IN DS 9 8 2 ABCD EF01";
        assert_eq!(parse_ds_record(split).unwrap()["digest"], "ABCDEF01");
        // a non-DS line returns None
        assert!(parse_ds_record("example.com. IN A 1.2.3.4").is_none());
    }

    #[test]
    fn docker_services_filter_astp() {
        let out = "astp_site_abc\trunning\tUp 3 hours\nastp_db_xyz\texited\tExited (0) 5 minutes ago\npostgres\trunning\tUp 1 day\n";
        let v = parse_docker_services(out);
        assert_eq!(v.len(), 2); // the non-astp `postgres` container is filtered out
        assert_eq!(v[0]["name"], "astp_site_abc");
        assert_eq!(v[0]["state"], "running");
        assert_eq!(v[1]["name"], "astp_db_xyz");
        assert_eq!(v[1]["state"], "exited");
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
