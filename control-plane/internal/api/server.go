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
			r.With(middleware.CSRF).Post("/auth/refresh", s.handleRefresh)
			// Agent bootstrap: authenticated by the one-time enrollment token itself.
			r.Post("/agents/enroll", s.handleAgentEnroll)
		})

		// --- Authenticated endpoints ---
		r.Group(func(r chi.Router) {
			r.Use(s.deps.Auth.Middleware)

			r.Get("/me", s.handleMe)
			// Bearer-authenticated (not cookie/CSRF-able), so no CSRF middleware.
			r.Post("/auth/logout", s.handleLogout)
			r.Post("/auth/totp/enroll", s.handleTOTPEnroll)
			r.Post("/auth/totp/confirm", s.handleTOTPConfirm)

			az := s.deps.Authz
			// Server nodes
			r.With(az.Require("node.read", "node.list", "server_node")).Get("/nodes", s.handleListNodes)
			r.With(az.Require("node.create", "node.create", "server_node")).Post("/nodes", s.handleCreateNode)
			r.With(az.Require("node.enroll", "node.enroll", "server_node")).Post("/nodes/{nodeID}/enroll", s.handleCreateEnrollment)

			// Metrics (fleet resource usage)
			r.With(az.Require("metrics.read", "metrics.read", "server_node")).Get("/metrics", s.handleMetrics)

			// Websites
			r.With(az.Require("website.read", "website.list", "website")).Get("/websites", s.handleListWebsites)
			r.With(az.Require("website.create", "website.create", "website")).Post("/websites", s.handleCreateWebsite)

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

			// Health checks (per-site probes + status)
			r.With(az.Require("website.read", "health.list", "website")).Get("/health", s.handleListHealth)
			r.With(az.Require("website.read", "health.incidents", "website")).Get("/health/incidents", s.handleListIncidents)
			r.With(az.Require("website.create", "health.check", "website")).Post("/sites/{siteID}/health/check", s.handleCheckHealth)

			// Runtime (language version per site)
			r.With(az.Require("website.read", "runtime.list", "website")).Get("/runtimes", s.handleListRuntimes)
			r.With(az.Require("website.create", "runtime.switch", "website")).Post("/sites/{siteID}/runtime", s.handleSwitchRuntime)

			// Deployments
			r.With(az.Require("deploy.create", "deploy.create", "deployment")).
				Post("/applications/{appID}/deployments", s.handleCreateDeployment)

			// Domains & DNS
			r.With(az.Require("domain.read", "domain.list", "domain")).Get("/domains", s.handleListDomains)
			r.With(az.Require("domain.create", "domain.create", "domain")).Post("/domains", s.handleCreateDomain)
			r.With(az.Require("dns.read", "dns.list", "dns_record")).Get("/dns", s.handleListDNSRecords)
			r.With(az.Require("dns.read", "dns.nameservers", "dns_record")).Get("/dns/nameservers", s.handleListNameservers)
			r.With(az.Require("dns.manage", "dns.create", "dns_record")).Post("/dns", s.handleCreateDNSRecord)
			r.With(az.Require("dns.manage", "dns.delete", "dns_record")).Delete("/dns/{recordID}", s.handleDeleteDNSRecord)

			// URL redirects (rendered into the Caddy config)
			r.With(az.Require("domain.read", "redirect.list", "domain")).Get("/redirects", s.handleListRedirects)
			r.With(az.Require("domain.create", "redirect.create", "domain")).Post("/redirects", s.handleCreateRedirect)
			r.With(az.Require("domain.create", "redirect.delete", "domain")).Delete("/redirects/{redirectID}", s.handleDeleteRedirect)

			// Databases (managed SQL/KV instances)
			r.With(az.Require("database.read", "database.list", "database_instance")).Get("/databases", s.handleListDatabases)
			r.With(az.Require("database.create", "database.create", "database_instance")).Post("/databases", s.handleCreateDatabase)
			r.With(az.Require("database.create", "database.user.create", "database_instance")).Post("/databases/{dbID}/users", s.handleCreateDBUser)
			r.With(az.Require("database.query", "database.query", "database_instance")).Post("/databases/{dbID}/query", s.handleDatabaseQuery)

			// SSL / TLS certificates
			r.With(az.Require("ssl.read", "ssl.list", "ssl_certificate")).Get("/ssl-certificates", s.handleListCertificates)
			r.With(az.Require("ssl.manage", "ssl.issue", "ssl_certificate")).Post("/ssl-certificates", s.handleIssueCertificate)
			r.With(az.Require("ssl.manage", "ssl.upload", "ssl_certificate")).Post("/ssl-certificates/upload", s.handleUploadCert)

			// Email mailboxes
			r.With(az.Require("email.read", "email.list", "mailbox")).Get("/email/mailboxes", s.handleListMailboxes)
			r.With(az.Require("email.manage", "email.create", "mailbox")).Post("/email/mailboxes", s.handleCreateMailbox)
			r.With(az.Require("email.manage", "mail.dkim", "domain")).Post("/email/dkim", s.handleGenerateDKIM)

			// Email forwarders / aliases (incl. catch-all)
			r.With(az.Require("email.read", "email.list", "mailbox")).Get("/email/forwarders", s.handleListForwarders)
			r.With(az.Require("email.manage", "email.create", "mailbox")).Post("/email/forwarders", s.handleCreateForwarder)
			r.With(az.Require("email.manage", "email.delete", "mailbox")).Delete("/email/forwarders/{forwarderID}", s.handleDeleteForwarder)

			// Email autoresponders (Sieve vacation)
			r.With(az.Require("email.read", "email.list", "mailbox")).Get("/email/autoresponders", s.handleListAutoresponders)
			r.With(az.Require("email.manage", "email.create", "mailbox")).Post("/email/autoresponders", s.handleCreateAutoresponder)
			r.With(az.Require("email.manage", "email.delete", "mailbox")).Delete("/email/autoresponders/{autoresponderID}", s.handleDeleteAutoresponder)

			// Email filters (Sieve rules)
			r.With(az.Require("email.read", "email.list", "mailbox")).Get("/email/filters", s.handleListFilters)
			r.With(az.Require("email.manage", "email.create", "mailbox")).Post("/email/filters", s.handleCreateFilter)
			r.With(az.Require("email.manage", "email.delete", "mailbox")).Delete("/email/filters/{filterID}", s.handleDeleteFilter)

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
			r.With(az.Require("backup.create", "backup.schedule.delete", "backup")).Delete("/backup-schedules/{scheduleID}", s.handleDeleteBackupSchedule)

			// Cron jobs
			r.With(az.Require("cron.read", "cron.list", "cron_job")).Get("/cron", s.handleListCron)
			r.With(az.Require("cron.manage", "cron.create", "cron_job")).Post("/cron", s.handleCreateCron)
			r.With(az.Require("cron.manage", "cron.delete", "cron_job")).Delete("/cron/{cronID}", s.handleDeleteCron)

			// FTP / SFTP accounts
			r.With(az.Require("ftp.read", "ftp.list", "ftp_account")).Get("/ftp-accounts", s.handleListFtp)
			r.With(az.Require("ftp.manage", "ftp.create", "ftp_account")).Post("/ftp-accounts", s.handleCreateFtp)
			r.With(az.Require("ftp.manage", "ftp.delete", "ftp_account")).Delete("/ftp-accounts/{ftpID}", s.handleDeleteFtp)

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
			r.With(az.Require("firewall.manage", "firewall.delete", "firewall_rule")).Delete("/firewall/{ruleID}", s.handleDeleteFirewall)

			// WAF — application-layer rules (reuses firewall.* permissions)
			r.With(az.Require("firewall.read", "waf.list", "waf_rule")).Get("/waf", s.handleListWaf)
			r.With(az.Require("firewall.manage", "waf.create", "waf_rule")).Post("/waf", s.handleCreateWaf)
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
