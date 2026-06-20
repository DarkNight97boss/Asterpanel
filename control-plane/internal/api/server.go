// Package api wires the HTTP server: dependency container, middleware chain and
// routes. Every protected route runs auth → RBAC+OPA before the handler.
package api

import (
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/redis/go-redis/v9"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/agentcomm"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/auth"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/authz"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/config"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/licensing"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/webhooks"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/webmail"
)

// Deps is the server's dependency container.
type Deps struct {
	Cfg               *config.Config
	Log               *slog.Logger
	Store             *store.Store
	JWT               *auth.JWTIssuer
	Envelope          *crypto.Envelope
	CA                *crypto.CA
	Signer            *jobs.Signer
	Dispatcher        *agentcomm.Dispatcher
	OPA               *authz.OPAClient
	Audit             audit.Sink
	Redis             *redis.Client
	Auth              *middleware.Authenticator
	Authz             *middleware.Authorizer
	RateLimiter       *middleware.RateLimiter
	Webmail           *webmail.Service
	Webhooks          *webhooks.Dispatcher
	WebAuthn          *webauthn.WebAuthn
	License           *licensing.Manager
	OpenAPIPath       string
	AgentBaseURL      string
	JobSigningPubPath string
}

type Server struct {
	deps   Deps
	router http.Handler
}

func NewServer(d Deps) *Server {
	s := &Server{deps: d}
	s.router = s.routes()
	return s
}

func (s *Server) Handler() http.Handler { return s.router }

func (s *Server) routes() http.Handler {
	r := chi.NewRouter()

	r.Use(middleware.RequestID)
	r.Use(middleware.Recover)
	r.Use(middleware.SecureHeaders)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   s.deps.Cfg.CORSOrigins,
		AllowedMethods:   []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions},
		AllowedHeaders:   []string{"Authorization", "Content-Type", "X-CSRF-Token", "X-Request-Id"},
		ExposedHeaders:   []string{"X-Request-Id"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Liveness / readiness / API docs (public).
	r.Get("/healthz", s.handleHealthz)
	r.Get("/readyz", s.handleReadyz)
	r.Get("/openapi.yaml", s.handleOpenAPISpec)
	r.Get("/swagger", s.handleSwaggerUI)
	// The Ed25519 job-signing public key is public; agents pin it during bootstrap.
	r.Get("/.well-known/asterpanel/job-signing-key", s.handleJobSigningKey)

	r.Route("/api/v1", func(r chi.Router) {
		// --- Public auth endpoints (rate-limited) ---
		r.Group(func(r chi.Router) {
			if s.deps.RateLimiter != nil {
				r.Use(s.deps.RateLimiter.For("auth"))
			}
			r.Post("/auth/login", s.handleLogin)
			r.Post("/auth/mfa/verify", s.handleMFAVerify)
			// Passkey (WebAuthn) login ceremony — public, rate-limited.
			r.Post("/auth/webauthn/login/begin", s.handleWebAuthnLoginBegin)
			r.Post("/auth/webauthn/login/finish", s.handleWebAuthnLoginFinish)
			// SSO (OIDC) login ceremony — public; state/nonce/PKCE guard the flow.
			r.Get("/auth/sso/providers", s.handlePublicSSOProviders)
			r.Get("/auth/sso/{providerID}/start", s.handleSSOStart)
			r.Get("/auth/sso/{providerID}/callback", s.handleSSOCallback)
			r.With(middleware.CSRF).Post("/auth/refresh", s.handleRefresh)
			// Agent bootstrap: authenticated by the one-time enrollment token itself.
			r.Post("/agents/enroll", s.handleAgentEnroll)
			// Dynamic DNS update: authenticated by the per-host update token.
			r.Get("/ddns/update", s.handleDdnsUpdate)
			r.Post("/ddns/update", s.handleDdnsUpdate)
		})

		// --- Authenticated endpoints ---
		r.Group(func(r chi.Router) {
			r.Use(s.deps.Auth.Middleware)

			r.Get("/me", s.handleMe)
			// Bearer-authenticated (not cookie/CSRF-able), so no CSRF middleware.
			r.Post("/auth/logout", s.handleLogout)
			// Impersonation ("log in as user"). Authorization is enforced in the
			// handler (superadmin, or reseller over its own sub-accounts).
			r.Post("/admin/impersonate", s.handleStartImpersonation)
			r.Post("/admin/impersonate/exit", s.handleStopImpersonation)
			r.Post("/auth/totp/enroll", s.handleTOTPEnroll)
			r.Post("/auth/totp/confirm", s.handleTOTPConfirm)

			az := s.deps.Authz
			// Server nodes
			r.With(az.Require("node.read", "node.list", "server_node")).Get("/nodes", s.handleListNodes)
			r.With(az.Require("node.create", "node.create", "server_node")).Post("/nodes", s.handleCreateNode)
			r.With(az.Require("node.enroll", "node.enroll", "server_node")).Post("/nodes/{nodeID}/enroll", s.handleCreateEnrollment)

			// Metrics (fleet resource usage)
			r.With(az.Require("metrics.read", "metrics.read", "server_node")).Get("/metrics", s.handleMetrics)
			r.With(az.Require("metrics.read", "metrics.read", "server_node")).Get("/metrics/history", s.handleMetricsHistory)

			// Websites
			r.With(az.Require("website.read", "website.list", "website")).Get("/websites", s.handleListWebsites)
			r.With(az.Require("website.create", "website.create", "website")).Post("/websites", s.handleCreateWebsite)
			r.With(az.Require("website.update", "website.rename", "website")).Post("/websites/{siteID}", s.handleRenameWebsite)

			// File manager (site-scoped, signed agent file API)
			r.With(az.Require("files.read", "file.list", "website")).Get("/sites/{siteID}/files", s.handleListFiles)
			r.With(az.Require("files.read", "file.read", "website")).Get("/sites/{siteID}/files/content", s.handleReadFile)
			r.With(az.Require("files.manage", "file.write", "website")).Put("/sites/{siteID}/files/content", s.handleWriteFile)
			r.With(az.Require("files.manage", "file.mkdir", "website")).Post("/sites/{siteID}/files/dir", s.handleMkdir)
			r.With(az.Require("files.manage", "file.delete", "website")).Delete("/sites/{siteID}/files", s.handleDeleteFile)
			r.With(az.Require("files.read", "antivirus.scan", "website")).Post("/sites/{siteID}/files/scan", s.handleScanFiles)

			// Container logs (site-scoped tail)
			r.With(az.Require("website.read", "logs.tail", "website")).Get("/sites/{siteID}/logs", s.handleSiteLogs)
			r.With(az.Require("metrics.read", "analytics.read", "website")).Get("/sites/{siteID}/analytics", s.handleSiteAnalytics)

			// Service manager (node containers: status + restart)
			r.With(az.Require("service.read", "service.list", "node")).Get("/services", s.handleListServices)
			r.With(az.Require("service.manage", "service.restart", "node")).Post("/services/restart", s.handleRestartService)

			// Health checks (per-site probes + status)
			r.With(az.Require("website.read", "health.list", "website")).Get("/health", s.handleListHealth)
			r.With(az.Require("website.read", "health.incidents", "website")).Get("/health/incidents", s.handleListIncidents)
			r.With(az.Require("website.create", "health.check", "website")).Post("/sites/{siteID}/health/check", s.handleCheckHealth)

			// Runtime (language version per site)
			r.With(az.Require("website.read", "runtime.list", "website")).Get("/runtimes", s.handleListRuntimes)
			r.With(az.Require("website.create", "runtime.switch", "website")).Post("/sites/{siteID}/runtime", s.handleSwitchRuntime)
			r.With(az.Require("website.create", "app.lifecycle", "website")).Post("/sites/{siteID}/lifecycle", s.handleSiteLifecycle)

			// Git push-to-deploy (bare repo + post-receive hook per site)
			r.With(az.Require("website.read", "git.repo.get", "website")).Get("/sites/{siteID}/git-repo", s.handleGetGitRepo)
			r.With(az.Require("website.create", "git.repo.enable", "website")).Post("/sites/{siteID}/git-repo", s.handleEnableGitRepo)
			r.With(az.Require("website.create", "git.repo.disable", "website")).Delete("/sites/{siteID}/git-repo", s.handleDeleteGitRepo)
			r.With(az.Require("website.read", "staging.get", "website")).Get("/sites/{siteID}/staging", s.handleGetStaging)
			r.With(az.Require("website.create", "staging.create", "website")).Post("/sites/{siteID}/staging", s.handleCreateStaging)
			r.With(az.Require("website.create", "staging.promote", "website")).Post("/sites/{siteID}/staging/promote", s.handlePromoteStaging)
			r.With(az.Require("website.create", "staging.destroy", "website")).Delete("/sites/{siteID}/staging", s.handleDeleteStaging)
			r.With(az.Require("website.read", "php.settings.list", "website")).Get("/sites/{siteID}/php-settings", s.handleListPhpSettings)
			r.With(az.Require("website.update", "php.settings.set", "website")).Post("/sites/{siteID}/php-settings", s.handleSetPhpSetting)
			r.With(az.Require("website.update", "php.settings.delete", "website")).Delete("/sites/{siteID}/php-settings/{settingID}", s.handleDeletePhpSetting)

			// Deployments
			r.With(az.Require("deploy.create", "deploy.create", "deployment")).
				Post("/applications/{appID}/deployments", s.handleCreateDeployment)

			// Application manager (config + per-app env)
			r.With(az.Require("website.read", "application.list", "application")).Get("/applications", s.handleListApplications)
			r.With(az.Require("website.create", "application.create", "application")).Post("/applications", s.handleCreateApplication)
			r.With(az.Require("website.read", "application.get", "application")).Get("/applications/{appID}", s.handleGetApplication)
			r.With(az.Require("website.update", "application.update", "application")).Post("/applications/{appID}/config", s.handleUpdateApplication)
			r.With(az.Require("website.read", "application.env.list", "application")).Get("/applications/{appID}/env", s.handleListAppEnv)
			r.With(az.Require("website.update", "application.env.set", "application")).Post("/applications/{appID}/env", s.handleSetAppEnv)
			r.With(az.Require("website.update", "application.env.delete", "application")).Delete("/applications/{appID}/env/{envID}", s.handleDeleteAppEnv)

			// Domains & DNS
			r.With(az.Require("domain.read", "domain.list", "domain")).Get("/domains", s.handleListDomains)
			r.With(az.Require("domain.create", "domain.create", "domain")).Post("/domains", s.handleCreateDomain)
			r.With(az.Require("dns.read", "dns.list", "dns_record")).Get("/dns", s.handleListDNSRecords)
			r.With(az.Require("dns.read", "dns.nameservers", "dns_record")).Get("/dns/nameservers", s.handleListNameservers)
			r.With(az.Require("dns.manage", "dns.create", "dns_record")).Post("/dns", s.handleCreateDNSRecord)
			r.With(az.Require("dns.manage", "dns.update", "dns_record")).Post("/dns/{recordID}", s.handleUpdateDNSRecord)
			r.With(az.Require("dns.manage", "dns.delete", "dns_record")).Delete("/dns/{recordID}", s.handleDeleteDNSRecord)

			// DNSSEC (zone signing + DS record)
			r.With(az.Require("dns.read", "dnssec.list", "dns_record")).Get("/dns/dnssec", s.handleListDnssec)
			r.With(az.Require("dns.manage", "dnssec.enable", "dns_record")).Post("/dns/dnssec", s.handleEnableDnssec)
			r.With(az.Require("dns.manage", "dnssec.disable", "dns_record")).Delete("/dns/dnssec/{dnssecID}", s.handleDisableDnssec)

			// URL redirects (rendered into the Caddy config)
			r.With(az.Require("domain.read", "redirect.list", "domain")).Get("/redirects", s.handleListRedirects)
			r.With(az.Require("domain.create", "redirect.create", "domain")).Post("/redirects", s.handleCreateRedirect)
			r.With(az.Require("domain.create", "redirect.delete", "domain")).Delete("/redirects/{redirectID}", s.handleDeleteRedirect)

			// Subdomains / addon domains / aliases (rendered into the Caddy config)
			r.With(az.Require("domain.read", "subdomain.list", "domain")).Get("/subdomains", s.handleListSubdomains)
			r.With(az.Require("domain.create", "subdomain.create", "domain")).Post("/subdomains", s.handleCreateSubdomain)
			r.With(az.Require("domain.create", "subdomain.update", "domain")).Post("/subdomains/{subID}", s.handleUpdateSubdomain)
			r.With(az.Require("domain.create", "subdomain.delete", "domain")).Delete("/subdomains/{subID}", s.handleDeleteSubdomain)

			// Directory privacy (Caddy HTTP basic-auth on a path)
			r.With(az.Require("domain.read", "protection.list", "domain")).Get("/directory-privacy", s.handleListDirPrivacy)
			r.With(az.Require("domain.create", "protection.create", "domain")).Post("/directory-privacy", s.handleCreateDirPrivacy)
			r.With(az.Require("domain.create", "protection.delete", "domain")).Delete("/directory-privacy/{protectionID}", s.handleDeleteDirPrivacy)

			// Dynamic DNS hosts (management; the update endpoint is public above)
			r.With(az.Require("dns.read", "ddns.list", "dns_record")).Get("/ddns", s.handleListDdns)
			r.With(az.Require("dns.manage", "ddns.create", "dns_record")).Post("/ddns", s.handleCreateDdns)
			r.With(az.Require("dns.manage", "ddns.delete", "dns_record")).Delete("/ddns/{ddnsID}", s.handleDeleteDdns)

			// Web Disk (WebDAV accounts rendered into the Caddy site block)
			r.With(az.Require("domain.read", "webdav.list", "domain")).Get("/webdav", s.handleListWebdav)
			r.With(az.Require("domain.create", "webdav.create", "domain")).Post("/webdav", s.handleCreateWebdav)
			r.With(az.Require("domain.create", "webdav.delete", "domain")).Delete("/webdav/{webdavID}", s.handleDeleteWebdav)

			// Hotlink protection (Caddy referer block on asset paths)
			r.With(az.Require("domain.read", "hotlink.list", "domain")).Get("/hotlink-protection", s.handleListHotlink)
			r.With(az.Require("domain.create", "hotlink.create", "domain")).Post("/hotlink-protection", s.handleCreateHotlink)
			r.With(az.Require("domain.create", "hotlink.delete", "domain")).Delete("/hotlink-protection/{hotlinkID}", s.handleDeleteHotlink)

			// Databases (managed SQL/KV instances)
			r.With(az.Require("database.read", "database.list", "database_instance")).Get("/databases", s.handleListDatabases)
			r.With(az.Require("database.create", "database.create", "database_instance")).Post("/databases", s.handleCreateDatabase)
			r.With(az.Require("database.read", "database.user.list", "database_instance")).Get("/databases/{dbID}/users", s.handleListDBUsers)
			r.With(az.Require("database.create", "database.user.create", "database_instance")).Post("/databases/{dbID}/users", s.handleCreateDBUser)
			r.With(az.Require("database.create", "database.user.privileges", "database_instance")).Put("/databases/{dbID}/users/{userID}/privileges", s.handleSetDBUserPrivileges)
			r.With(az.Require("database.create", "database.user.delete", "database_instance")).Delete("/databases/{dbID}/users/{userID}", s.handleDeleteDBUser)
			r.With(az.Require("database.query", "database.query", "database_instance")).Post("/databases/{dbID}/query", s.handleDatabaseQuery)
			r.With(az.Require("backup.create", "database.export", "database_instance")).Post("/databases/{dbID}/export", s.handleDatabaseExport)
			r.With(az.Require("database.read", "database.remote.list", "database_instance")).Get("/databases/{dbID}/remote-hosts", s.handleListRemoteHosts)
			r.With(az.Require("database.create", "database.remote.add", "database_instance")).Post("/databases/{dbID}/remote-hosts", s.handleCreateRemoteHost)
			r.With(az.Require("database.create", "database.remote.update", "database_instance")).Post("/databases/{dbID}/remote-hosts/{hostID}", s.handleUpdateRemoteHost)
			r.With(az.Require("database.create", "database.remote.remove", "database_instance")).Delete("/databases/{dbID}/remote-hosts/{hostID}", s.handleDeleteRemoteHost)

			// SSL / TLS certificates
			r.With(az.Require("ssl.read", "ssl.list", "ssl_certificate")).Get("/ssl-certificates", s.handleListCertificates)
			r.With(az.Require("ssl.manage", "ssl.issue", "ssl_certificate")).Post("/ssl-certificates", s.handleIssueCertificate)
			r.With(az.Require("ssl.manage", "ssl.upload", "ssl_certificate")).Post("/ssl-certificates/upload", s.handleUploadCert)

			// Email mailboxes
			r.With(az.Require("email.read", "email.list", "mailbox")).Get("/email/mailboxes", s.handleListMailboxes)
			r.With(az.Require("email.manage", "email.create", "mailbox")).Post("/email/mailboxes", s.handleCreateMailbox)
			r.With(az.Require("email.manage", "email.update", "mailbox")).Post("/email/mailboxes/{mailboxID}", s.handleUpdateMailbox)
			r.With(az.Require("email.manage", "email.update", "mailbox")).Post("/email/mailboxes/{mailboxID}/password", s.handleResetMailboxPassword)
			r.With(az.Require("email.manage", "mail.dkim", "domain")).Post("/email/dkim", s.handleGenerateDKIM)

			// Email forwarders / aliases (incl. catch-all)
			r.With(az.Require("email.read", "email.list", "mailbox")).Get("/email/forwarders", s.handleListForwarders)
			r.With(az.Require("email.manage", "email.create", "mailbox")).Post("/email/forwarders", s.handleCreateForwarder)
			r.With(az.Require("email.manage", "email.update", "mailbox")).Post("/email/forwarders/{forwarderID}", s.handleUpdateForwarder)
			r.With(az.Require("email.manage", "email.delete", "mailbox")).Delete("/email/forwarders/{forwarderID}", s.handleDeleteForwarder)

			// Email autoresponders (Sieve vacation)
			r.With(az.Require("email.read", "email.list", "mailbox")).Get("/email/autoresponders", s.handleListAutoresponders)
			r.With(az.Require("email.manage", "email.create", "mailbox")).Post("/email/autoresponders", s.handleCreateAutoresponder)
			r.With(az.Require("email.manage", "email.update", "mailbox")).Post("/email/autoresponders/{autoresponderID}", s.handleUpdateAutoresponder)
			r.With(az.Require("email.manage", "email.delete", "mailbox")).Delete("/email/autoresponders/{autoresponderID}", s.handleDeleteAutoresponder)

			// Email filters (Sieve rules)
			r.With(az.Require("email.read", "email.list", "mailbox")).Get("/email/filters", s.handleListFilters)
			r.With(az.Require("email.manage", "email.create", "mailbox")).Post("/email/filters", s.handleCreateFilter)
			r.With(az.Require("email.manage", "email.update", "mailbox")).Post("/email/filters/{filterID}", s.handleUpdateFilter)
			r.With(az.Require("email.manage", "email.delete", "mailbox")).Delete("/email/filters/{filterID}", s.handleDeleteFilter)

			// Mail queue (Postfix: view / flush / delete deferred mail)
			r.With(az.Require("email.read", "email.list", "mailbox")).Get("/email/queue", s.handleMailQueueList)
			r.With(az.Require("email.manage", "email.create", "mailbox")).Post("/email/queue/action", s.handleMailQueueAction)
			r.With(az.Require("email.read", "email.list", "mailbox")).Post("/email/track-delivery", s.handleTrackDelivery)

			// Mailing lists (fan-out aliases with member management)
			r.With(az.Require("email.read", "email.list", "mailbox")).Get("/email/lists", s.handleListMailLists)
			r.With(az.Require("email.manage", "email.create", "mailbox")).Post("/email/lists", s.handleCreateMailList)
			r.With(az.Require("email.manage", "email.delete", "mailbox")).Delete("/email/lists/{listID}", s.handleDeleteMailList)
			r.With(az.Require("email.manage", "email.create", "mailbox")).Post("/email/lists/{listID}/members", s.handleAddListMember)
			r.With(az.Require("email.manage", "email.delete", "mailbox")).Delete("/email/lists/members/{memberID}", s.handleDeleteListMember)

			// CalDAV/CardDAV (Radicale calendars + contacts)
			r.With(az.Require("email.manage", "caldav.ensure", "mailbox")).Post("/email/caldav/ensure", s.handleEnsureCaldav)
			r.With(az.Require("email.read", "email.list", "mailbox")).Get("/email/caldav/accounts", s.handleListCaldav)
			r.With(az.Require("email.manage", "email.create", "mailbox")).Post("/email/caldav/accounts", s.handleCreateCaldav)
			r.With(az.Require("email.manage", "email.delete", "mailbox")).Delete("/email/caldav/accounts/{accountID}", s.handleDeleteCaldav)

			// Spam management (Rspamd thresholds + allow/deny lists)
			r.With(az.Require("email.read", "email.spam", "mailbox")).Get("/email/spam", s.handleGetSpam)
			r.With(az.Require("email.manage", "email.spam", "mailbox")).Put("/email/spam/settings", s.handleUpdateSpamSettings)
			r.With(az.Require("email.manage", "email.spam", "mailbox")).Post("/email/spam/rules", s.handleCreateSpamRule)
			r.With(az.Require("email.manage", "email.spam", "mailbox")).Delete("/email/spam/rules/{ruleID}", s.handleDeleteSpamRule)

			// Native webmail client (IMAP/SMTP gateway)
			r.With(az.Require("email.read", "email.list", "mailbox")).Get("/webmail/{mailboxID}/folders", s.handleWebmailFolders)
			r.With(az.Require("email.read", "email.list", "mailbox")).Get("/webmail/{mailboxID}/messages", s.handleWebmailMessages)
			r.With(az.Require("email.read", "email.read", "mailbox")).Get("/webmail/{mailboxID}/messages/{uid}", s.handleWebmailMessage)
			r.With(az.Require("email.manage", "email.send", "mailbox")).Post("/webmail/{mailboxID}/send", s.handleWebmailSend)
			r.With(az.Require("email.manage", "email.server", "mailbox")).Post("/email/server/ensure", s.handleEnsureMailServer)

			// Backups & restore
			r.With(az.Require("backup.read", "backup.list", "backup")).Get("/backups", s.handleListBackups)
			r.With(az.Require("backup.create", "backup.create", "backup")).Post("/backups", s.handleCreateBackup)
			r.With(az.Require("backup.restore", "backup.restore", "backup")).Post("/backups/{backupID}/restore", s.handleRestoreBackup)
			r.With(az.Require("backup.read", "backup.schedule.list", "backup")).Get("/backup-schedules", s.handleListBackupSchedules)
			r.With(az.Require("backup.create", "backup.schedule.create", "backup")).Post("/backup-schedules", s.handleCreateBackupSchedule)
			r.With(az.Require("backup.create", "backup.schedule.update", "backup")).Post("/backup-schedules/{scheduleID}", s.handleUpdateBackupSchedule)
			r.With(az.Require("backup.create", "backup.schedule.delete", "backup")).Delete("/backup-schedules/{scheduleID}", s.handleDeleteBackupSchedule)

			// Cron jobs
			r.With(az.Require("cron.read", "cron.list", "cron_job")).Get("/cron", s.handleListCron)
			r.With(az.Require("cron.manage", "cron.create", "cron_job")).Post("/cron", s.handleCreateCron)
			r.With(az.Require("cron.manage", "cron.update", "cron_job")).Post("/cron/{cronID}", s.handleUpdateCron)
			r.With(az.Require("cron.manage", "cron.delete", "cron_job")).Delete("/cron/{cronID}", s.handleDeleteCron)

			// FTP / SFTP accounts
			r.With(az.Require("ftp.read", "ftp.list", "ftp_account")).Get("/ftp-accounts", s.handleListFtp)
			r.With(az.Require("ftp.manage", "ftp.create", "ftp_account")).Post("/ftp-accounts", s.handleCreateFtp)
			r.With(az.Require("ftp.manage", "ftp.delete", "ftp_account")).Delete("/ftp-accounts/{ftpID}", s.handleDeleteFtp)

			// SSH authorized keys (cPanel "SSH Access") — rendered into authorized_keys
			r.With(az.Require("ftp.read", "ssh.key.list", "ftp_account")).Get("/ssh-keys", s.handleListSSHKeys)
			r.With(az.Require("ftp.manage", "ssh.key.add", "ftp_account")).Post("/ssh-keys", s.handleCreateSSHKey)
			r.With(az.Require("ftp.manage", "ssh.key.rename", "ftp_account")).Post("/ssh-keys/{keyID}", s.handleRenameSSHKey)
			r.With(az.Require("ftp.manage", "ssh.key.remove", "ftp_account")).Delete("/ssh-keys/{keyID}", s.handleDeleteSSHKey)

			// Environment variables
			r.With(az.Require("env.read", "env.list", "env_var")).Get("/env", s.handleListEnv)
			r.With(az.Require("env.manage", "env.create", "env_var")).Post("/env", s.handleCreateEnv)
			r.With(az.Require("env.manage", "env.delete", "env_var")).Delete("/env/{envID}", s.handleDeleteEnv)

			// Secrets (org-level)
			r.With(az.Require("secret.read", "secret.list", "secret")).Get("/secrets", s.handleListSecrets)
			r.With(az.Require("secret.manage", "secret.create", "secret")).Post("/secrets", s.handleCreateSecret)
			r.With(az.Require("secret.manage", "secret.delete", "secret")).Delete("/secrets/{secretID}", s.handleDeleteSecret)

			// Firewall
			r.With(az.Require("firewall.read", "firewall.list", "firewall_rule")).Get("/firewall", s.handleListFirewall)
			r.With(az.Require("firewall.manage", "firewall.create", "firewall_rule")).Post("/firewall", s.handleCreateFirewall)
			r.With(az.Require("firewall.manage", "firewall.update", "firewall_rule")).Post("/firewall/{ruleID}", s.handleUpdateFirewall)
			r.With(az.Require("firewall.manage", "firewall.delete", "firewall_rule")).Delete("/firewall/{ruleID}", s.handleDeleteFirewall)

			// Security Advisor (read-only posture audit + recommendations)
			r.With(az.Require("firewall.read", "security.advisor", "organization")).Get("/security/advisor", s.handleSecurityAdvisor)

			// WAF — application-layer rules (reuses firewall.* permissions)
			r.With(az.Require("firewall.read", "waf.list", "waf_rule")).Get("/waf", s.handleListWaf)
			r.With(az.Require("firewall.manage", "waf.create", "waf_rule")).Post("/waf", s.handleCreateWaf)
			r.With(az.Require("firewall.manage", "waf.update", "waf_rule")).Post("/waf/{ruleID}", s.handleUpdateWaf)
			r.With(az.Require("firewall.manage", "waf.delete", "waf_rule")).Delete("/waf/{ruleID}", s.handleDeleteWaf)

			// Edition / license (any authenticated user; drives the UI lock state)
			r.Get("/license", s.handleLicense)

			// Passkeys (WebAuthn) — self-service registration + listing.
			r.Get("/auth/webauthn/passkeys", s.handleListPasskeys)
			r.Post("/auth/webauthn/register/begin", s.handleWebAuthnRegisterBegin)
			r.Post("/auth/webauthn/register/finish", s.handleWebAuthnRegisterFinish)

			// Billing & usage. The plan/usage view stays in Community; the
			// invoicing engine is a Pro (commercial) feature.
			r.With(az.Require("billing.read", "billing.read", "billing")).Get("/billing", s.handleBilling)

			// Hosting packages (plans + quotas). Definition/enforcement is free;
			// only the invoicing engine below is a commercial feature.
			r.With(az.Require("billing.read", "plan.list", "billing")).Get("/plans", s.handleListPlans)
			r.With(az.Require("billing.manage", "plan.create", "billing")).Post("/plans", s.handleCreatePlan)
			r.With(az.Require("billing.read", "plan.get", "billing")).Get("/plans/{planID}", s.handleGetPlan)
			r.With(az.Require("billing.manage", "plan.update", "billing")).Post("/plans/{planID}", s.handleUpdatePlan)
			r.With(az.Require("billing.manage", "plan.delete", "billing")).Delete("/plans/{planID}", s.handleDeletePlan)

			// SSO (OIDC) provider configuration (operator/org admin).
			r.With(az.Require("sso.read", "sso.list", "sso_provider")).Get("/sso/providers", s.handleListSSOProviders)
			r.With(az.Require("sso.manage", "sso.create", "sso_provider")).Post("/sso/providers", s.handleCreateSSOProvider)
			r.With(az.Require("sso.manage", "sso.update", "sso_provider")).Post("/sso/providers/{providerID}", s.handleUpdateSSOProvider)
			r.With(az.Require("sso.manage", "sso.delete", "sso_provider")).Delete("/sso/providers/{providerID}", s.handleDeleteSSOProvider)

			// CDN / Cloudflare integration (DNS records + cache purge).
			r.With(az.Require("cdn.read", "cloudflare.get", "cloudflare_account")).Get("/cdn/cloudflare", s.handleGetCloudflare)
			r.With(az.Require("cdn.manage", "cloudflare.connect", "cloudflare_account")).Post("/cdn/cloudflare", s.handleConnectCloudflare)
			r.With(az.Require("cdn.manage", "cloudflare.disconnect", "cloudflare_account")).Delete("/cdn/cloudflare", s.handleDisconnectCloudflare)
			r.With(az.Require("cdn.read", "cloudflare.zones", "cloudflare_account")).Get("/cdn/cloudflare/zones", s.handleListCloudflareZones)
			r.With(az.Require("cdn.read", "cloudflare.dns.list", "cloudflare_account")).Get("/cdn/cloudflare/zones/{zoneID}/dns", s.handleListCloudflareDNS)
			r.With(az.Require("cdn.manage", "cloudflare.dns.create", "cloudflare_account")).Post("/cdn/cloudflare/zones/{zoneID}/dns", s.handleCreateCloudflareDNS)
			r.With(az.Require("cdn.manage", "cloudflare.dns.update", "cloudflare_account")).Post("/cdn/cloudflare/zones/{zoneID}/dns/{recordID}", s.handleUpdateCloudflareDNS)
			r.With(az.Require("cdn.manage", "cloudflare.dns.delete", "cloudflare_account")).Delete("/cdn/cloudflare/zones/{zoneID}/dns/{recordID}", s.handleDeleteCloudflareDNS)
			r.With(az.Require("cdn.manage", "cloudflare.cache.purge", "cloudflare_account")).Post("/cdn/cloudflare/zones/{zoneID}/purge", s.handlePurgeCloudflareCache)

			r.Group(func(r chi.Router) {
				r.Use(s.requireFeature(licensing.FeatureBilling))
				r.With(az.Require("billing.read", "billing.invoices.list", "invoice")).Get("/billing/invoices", s.handleListInvoices)
				r.With(az.Require("billing.read", "billing.invoices.get", "invoice")).Get("/billing/invoices/{invoiceID}", s.handleGetInvoice)
				r.With(az.Require("billing.manage", "invoice.create", "invoice")).Post("/billing/invoices", s.handleGenerateInvoice)
				r.With(az.Require("billing.manage", "invoice.pay", "invoice")).Post("/billing/invoices/{invoiceID}/pay", s.handlePayInvoice)
			})

			// Reseller — sub-account hierarchy (Pro)
			r.Group(func(r chi.Router) {
				r.Use(s.requireFeature(licensing.FeatureReseller))
				r.With(az.Require("reseller.read", "reseller.list", "organization")).Get("/reseller/accounts", s.handleListSubAccounts)
				r.With(az.Require("reseller.manage", "reseller.create", "organization")).Post("/reseller/accounts", s.handleCreateSubAccount)
				r.With(az.Require("reseller.manage", "reseller.status", "organization")).Post("/reseller/accounts/{accountID}/status", s.handleSetSubAccountStatus)
				r.With(az.Require("reseller.manage", "reseller.plan", "organization")).Post("/reseller/accounts/{accountID}/plan", s.handleAssignSubAccountPlan)
			})

			// White-label branding — reading is free (the panel still themes);
			// customizing it is Pro.
			r.With(az.Require("branding.read", "branding.read", "organization")).Get("/branding", s.handleGetBranding)
			r.With(s.requireFeature(licensing.FeatureWhiteLabel)).
				With(az.Require("branding.manage", "branding.update", "organization")).Put("/branding", s.handleUpdateBranding)

			// Customer webhooks (Pro — part of the white-label / customer-facing API)
			r.Group(func(r chi.Router) {
				r.Use(s.requireFeature(licensing.FeatureWhiteLabel))
				r.With(az.Require("webhooks.read", "webhooks.list", "webhook")).Get("/webhooks", s.handleListWebhooks)
				r.With(az.Require("webhooks.manage", "webhooks.create", "webhook")).Post("/webhooks", s.handleCreateWebhook)
				r.With(az.Require("webhooks.manage", "webhooks.update", "webhook")).Post("/webhooks/{hookID}", s.handleUpdateWebhook)
				r.With(az.Require("webhooks.manage", "webhooks.delete", "webhook")).Delete("/webhooks/{hookID}", s.handleDeleteWebhook)
				r.With(az.Require("webhooks.manage", "webhooks.test", "webhook")).Post("/webhooks/{hookID}/test", s.handleTestWebhook)
			})

			// Migration tooling — import from cPanel/Plesk (Pro)
			r.Group(func(r chi.Router) {
				r.Use(s.requireFeature(licensing.FeatureMigration))
				r.With(az.Require("migration.read", "migration.list", "migration")).Get("/migrations", s.handleListMigrations)
				r.With(az.Require("migration.read", "migration.get", "migration")).Get("/migrations/{migrationID}", s.handleGetMigration)
				r.With(az.Require("migration.manage", "migration.plan", "migration")).Post("/migrations", s.handleCreateMigration)
				r.With(az.Require("migration.manage", "migration.import", "migration")).Post("/migrations/{migrationID}/import", s.handleRunImport)
			})

			// API tokens (scoped machine credentials)
			r.With(az.Require("apitoken.read", "apitoken.list", "api_token")).Get("/api-tokens", s.handleListAPITokens)
			r.With(az.Require("apitoken.create", "apitoken.create", "api_token")).Post("/api-tokens", s.handleCreateAPIToken)
			r.With(az.Require("apitoken.revoke", "apitoken.revoke", "api_token")).Delete("/api-tokens/{tokenID}", s.handleRevokeAPIToken)
		})
	})

	// Agent → control-plane job status callback. In production this listener is
	// terminated behind mTLS (client cert = the enrolled agent); see deploy docs.
	r.Post("/internal/agent/jobs/{jobID}/status", s.handleAgentJobStatus)
	// Agent → control-plane metrics ingest (same mTLS guard as above).
	r.Post("/internal/agent/nodes/{nodeID}/metrics", s.handleAgentMetrics)

	return r
}

// --- infra handlers ---

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 2*time.Second)
	defer cancel()
	if err := s.deps.Store.Pool().Ping(ctx); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"status":"db_unavailable"}`))
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"ready"}`))
}

func (s *Server) handleOpenAPISpec(w http.ResponseWriter, r *http.Request) {
	path := s.deps.OpenAPIPath
	if path == "" {
		path = "api/openapi.yaml"
	}
	b, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "spec not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/yaml")
	_, _ = w.Write(b)
}

func (s *Server) handleSwaggerUI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(swaggerHTML))
}

func (s *Server) handleJobSigningKey(w http.ResponseWriter, r *http.Request) {
	b, err := os.ReadFile(s.deps.JobSigningPubPath)
	if err != nil {
		http.Error(w, "signing key unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/x-pem-file")
	_, _ = w.Write(b)
}

const swaggerHTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>AsterPanel API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="swagger"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.onload=()=>{window.ui=SwaggerUIBundle({url:'/openapi.yaml',dom_id:'#swagger'})}</script>
</body></html>`
