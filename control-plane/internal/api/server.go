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
	"github.com/redis/go-redis/v9"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/agentcomm"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/auth"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/authz"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/config"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
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

			// Websites
			r.With(az.Require("website.read", "website.list", "website")).Get("/websites", s.handleListWebsites)
			r.With(az.Require("website.create", "website.create", "website")).Post("/websites", s.handleCreateWebsite)

			// Deployments
			r.With(az.Require("deploy.create", "deploy.create", "deployment")).
				Post("/applications/{appID}/deployments", s.handleCreateDeployment)

			// API tokens (scoped machine credentials)
			r.With(az.Require("apitoken.read", "apitoken.list", "api_token")).Get("/api-tokens", s.handleListAPITokens)
			r.With(az.Require("apitoken.create", "apitoken.create", "api_token")).Post("/api-tokens", s.handleCreateAPIToken)
			r.With(az.Require("apitoken.revoke", "apitoken.revoke", "api_token")).Delete("/api-tokens/{tokenID}", s.handleRevokeAPIToken)
		})
	})

	// Agent → control-plane job status callback. In production this listener is
	// terminated behind mTLS (client cert = the enrolled agent); see deploy docs.
	r.Post("/internal/agent/jobs/{jobID}/status", s.handleAgentJobStatus)

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
