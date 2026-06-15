// Command controlplane is the AsterPanel control-plane API server.
//
// Subcommands:
//
//	controlplane serve           Run the HTTP API server (default).
//	controlplane create-admin    Create a superadmin user + owner membership.
//	controlplane version         Print the build version.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/agentcomm"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/api"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/auth"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/authz"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/config"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/logging"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

var version = "0.1.0-dev"

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "serve":
		runServe()
	case "create-admin":
		runCreateAdmin(os.Args[2:])
	case "version", "-v", "--version":
		fmt.Println("asterpanel control-plane", version)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\nusage: controlplane [serve|create-admin|version]\n", cmd)
		os.Exit(2)
	}
}

func runServe() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config error:", err)
		os.Exit(1)
	}
	log := logging.New(cfg.LogLevel, cfg.LogFormat)

	ctx := context.Background()
	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("database connection failed", "error", err)
		os.Exit(1)
	}
	defer st.Close()

	rdb := mustRedis(cfg.RedisURL, log)
	if rdb != nil {
		defer rdb.Close()
	}

	envelope, err := crypto.NewEnvelope(cfg.SecretsMasterKey, "secrets-master-1")
	if err != nil {
		log.Error("secrets envelope init failed", "error", err)
		os.Exit(1)
	}

	var ca *crypto.CA
	if loaded, caErr := crypto.LoadCA(cfg.MTLSCACertPath, cfg.MTLSCAKeyPath); caErr != nil {
		log.Warn("CA not loaded; agent enrollment disabled until `make secrets`", "error", caErr)
	} else {
		ca = loaded
	}

	signer := loadSigner(cfg, log)
	dispatcher := agentcomm.NewDispatcher(cfg.MTLSCACertPath, cfg.ClientCertPath, cfg.ClientKeyPath, cfg.JobSigningKeyID)
	if !dispatcher.Configured() {
		log.Warn("mTLS agent dispatcher not configured; jobs will persist as pending (run `make secrets`)")
	}

	jwtIssuer := auth.NewJWTIssuer(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience, cfg.AccessTTL)
	opa := authz.NewOPAClient(cfg.OPAURL)
	authenticator := middleware.NewAuthenticator(st, jwtIssuer)
	authorizer := middleware.NewAuthorizer(opa, st, cfg.IsProd())

	var rl *middleware.RateLimiter
	if rdb != nil {
		rl = middleware.NewRateLimiter(rdb, 60, time.Minute) // 60 auth attempts/min/IP
	}

	server := api.NewServer(api.Deps{
		Cfg:          cfg,
		Log:          log,
		Store:        st,
		JWT:          jwtIssuer,
		Envelope:     envelope,
		CA:           ca,
		Signer:       signer,
		Dispatcher:   dispatcher,
		OPA:          opa,
		Audit:        st,
		Redis:        rdb,
		Auth:         authenticator,
		Authz:        authorizer,
		RateLimiter:  rl,
		OpenAPIPath:       getenv("OPENAPI_PATH", "api/openapi.yaml"),
		AgentBaseURL:      getenv("AGENT_DEV_BASE_URL", "https://node-agent:7443"),
		JobSigningPubPath: cfg.JobSigningPubPath,
	})

	httpSrv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		log.Info("control-plane listening", "addr", cfg.HTTPAddr, "env", cfg.Env, "version", version)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server error", "error", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "error", err)
	}
}

// loadSigner loads the Ed25519 job-signing key, falling back to an ephemeral
// dev key (with a loud warning) so the API still boots before `make secrets`.
func loadSigner(cfg *config.Config, log interface{ Warn(string, ...any) }) *jobs.Signer {
	priv, err := crypto.LoadEd25519PrivateKeyPEM(cfg.JobSigningPrivPath)
	if err == nil {
		return jobs.NewSigner(priv, cfg.JobSigningKeyID)
	}
	log.Warn("job signing key not loaded; using EPHEMERAL dev key (agents will reject signatures until `make secrets`)",
		"error", err, "path", cfg.JobSigningPrivPath)
	_, eph, _ := ed25519.GenerateKey(rand.Reader)
	return jobs.NewSigner(eph, cfg.JobSigningKeyID+"-ephemeral")
}

func mustRedis(url string, log interface {
	Warn(string, ...any)
}) *redis.Client {
	opt, err := redis.ParseURL(url)
	if err != nil {
		log.Warn("invalid REDIS_URL; rate limiting and MFA degraded", "error", err)
		return nil
	}
	rdb := redis.NewClient(opt)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Warn("redis unreachable; rate limiting and MFA degraded", "error", err)
		_ = rdb.Close()
		return nil
	}
	return rdb
}

// runCreateAdmin provisions an initial superadmin and owner membership.
func runCreateAdmin(args []string) {
	fs := flag.NewFlagSet("create-admin", flag.ExitOnError)
	email := fs.String("email", "", "admin email (required)")
	password := fs.String("password", "", "admin password (required)")
	orgSlug := fs.String("org", "acme", "organization slug to attach as owner")
	name := fs.String("name", "Administrator", "full name")
	superadmin := fs.Bool("superadmin", true, "grant platform superadmin")
	_ = fs.Parse(args)

	if *email == "" || *password == "" {
		fmt.Fprintln(os.Stderr, "create-admin: --email and --password are required")
		os.Exit(2)
	}

	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config error:", err)
		os.Exit(1)
	}
	ctx := context.Background()
	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "database error:", err)
		os.Exit(1)
	}
	defer st.Close()

	hash, err := crypto.HashPassword(*password)
	if err != nil {
		fmt.Fprintln(os.Stderr, "hash error:", err)
		os.Exit(1)
	}

	user, err := st.GetUserByEmail(ctx, *email)
	if err != nil {
		user, err = st.CreateUser(ctx, *email, hash, *name, *superadmin)
		if err != nil {
			fmt.Fprintln(os.Stderr, "create user error:", err)
			os.Exit(1)
		}
	} else {
		if err := st.SetPasswordHash(ctx, user.ID, hash); err != nil {
			fmt.Fprintln(os.Stderr, "update password error:", err)
			os.Exit(1)
		}
	}

	org, err := st.GetOrgBySlug(ctx, *orgSlug)
	if err != nil {
		fmt.Fprintf(os.Stderr, "organization %q not found (run `make seed` first)\n", *orgSlug)
		os.Exit(1)
	}
	roleID, err := st.GetSystemRoleID(ctx, "owner")
	if err != nil {
		fmt.Fprintln(os.Stderr, "owner role not found (run `make seed` first):", err)
		os.Exit(1)
	}
	if err := st.CreateMembership(ctx, user.ID, org.ID, roleID); err != nil {
		fmt.Fprintln(os.Stderr, "membership error:", err)
		os.Exit(1)
	}

	fmt.Printf("✓ admin ready: %s (org=%s, owner, superadmin=%v, user_id=%s)\n",
		*email, *orgSlug, *superadmin, user.ID)
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
