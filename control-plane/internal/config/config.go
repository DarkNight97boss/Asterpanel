// Package config loads and validates all control-plane configuration from the
// environment. It fails fast: a misconfigured security parameter must never
// silently fall back to an insecure default in production.
package config

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

type Config struct {
	Env         string
	LogLevel    string
	LogFormat   string
	HTTPAddr    string
	PublicURL   string
	WebURL      string
	CORSOrigins []string

	DatabaseURL string
	RedisURL    string
	NATSURL     string
	OPAURL      string

	JWTSecret   []byte
	AccessTTL   time.Duration
	RefreshTTL  time.Duration
	JWTIssuer   string
	JWTAudience string

	WebAuthnRPID     string
	WebAuthnRPName   string
	WebAuthnRPOrigin string

	JobSigningKeyID    string
	JobSigningPrivPath string
	JobSigningPubPath  string
	JobDefaultTTL      time.Duration

	MTLSCACertPath string
	MTLSCAKeyPath  string
	ClientCertPath string
	ClientKeyPath  string

	SecretsMasterKey []byte

	// Webmail gateway: the IMAP/SMTP server the panel connects to on behalf of a
	// mailbox. Empty => webmail endpoints return 503 (not configured).
	WebmailIMAPAddr string
	WebmailSMTPAddr string
	WebmailIMAPTLS  bool
	WebmailSMTPTLS  bool
}

// Load reads configuration from the environment and validates it.
func Load() (*Config, error) {
	c := &Config{
		Env:                getenv("ASTERPANEL_ENV", "development"),
		LogLevel:           getenv("LOG_LEVEL", "info"),
		LogFormat:          getenv("LOG_FORMAT", "json"),
		HTTPAddr:           getenv("CONTROL_PLANE_HTTP_ADDR", ":8080"),
		PublicURL:          getenv("CONTROL_PLANE_PUBLIC_URL", "http://localhost:8080"),
		WebURL:             getenv("WEB_PUBLIC_URL", "http://localhost:3000"),
		CORSOrigins:        splitNonEmpty(getenv("CORS_ALLOWED_ORIGINS", "http://localhost:3000")),
		DatabaseURL:        os.Getenv("DATABASE_URL"),
		RedisURL:           getenv("REDIS_URL", "redis://redis:6379/0"),
		NATSURL:            getenv("NATS_URL", "nats://nats:4222"),
		OPAURL:             getenv("OPA_URL", "http://opa:8181"),
		JWTIssuer:          getenv("JWT_ISSUER", "asterpanel"),
		JWTAudience:        getenv("JWT_AUDIENCE", "asterpanel-web"),
		WebAuthnRPID:       getenv("WEBAUTHN_RP_ID", "localhost"),
		WebAuthnRPName:     getenv("WEBAUTHN_RP_NAME", "AsterPanel"),
		WebAuthnRPOrigin:   getenv("WEBAUTHN_RP_ORIGIN", "http://localhost:3000"),
		JobSigningKeyID:    getenv("JOB_SIGNING_KEY_ID", "cp-dev-1"),
		JobSigningPrivPath: getenv("JOB_SIGNING_PRIVATE_KEY_PATH", "/secrets/job-signing/ed25519.key"),
		JobSigningPubPath:  getenv("JOB_SIGNING_PUBLIC_KEY_PATH", "/secrets/job-signing/ed25519.pub"),
		MTLSCACertPath:     getenv("MTLS_CA_CERT_PATH", "/secrets/ca/ca.crt"),
		MTLSCAKeyPath:      getenv("MTLS_CA_KEY_PATH", "/secrets/ca/ca.key"),
		ClientCertPath:     getenv("CONTROL_PLANE_CLIENT_CERT_PATH", "/secrets/control-plane/client.crt"),
		ClientKeyPath:      getenv("CONTROL_PLANE_CLIENT_KEY_PATH", "/secrets/control-plane/client.key"),
		WebmailIMAPAddr:    os.Getenv("WEBMAIL_IMAP_ADDR"),
		WebmailSMTPAddr:    os.Getenv("WEBMAIL_SMTP_ADDR"),
		WebmailIMAPTLS:     getenv("WEBMAIL_IMAP_TLS", "true") == "true",
		WebmailSMTPTLS:     getenv("WEBMAIL_SMTP_TLS", "true") == "true",
	}

	var err error
	if c.AccessTTL, err = parseDuration("ACCESS_TOKEN_TTL", "10m"); err != nil {
		return nil, err
	}
	if c.RefreshTTL, err = parseDuration("REFRESH_TOKEN_TTL", "720h"); err != nil {
		return nil, err
	}
	if c.JobDefaultTTL, err = parseDuration("JOB_DEFAULT_TTL", "30s"); err != nil {
		return nil, err
	}

	if c.JWTSecret, err = decodeKey("JWT_SIGNING_SECRET", 32); err != nil {
		return nil, err
	}
	if c.SecretsMasterKey, err = decodeKey("SECRETS_MASTER_KEY", 32); err != nil {
		return nil, err
	}

	if err := c.validate(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Config) IsProd() bool { return c.Env == "production" }

func (c *Config) validate() error {
	if c.DatabaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	if c.IsProd() {
		if isDevPlaceholder(c.JWTSecret) {
			return errors.New("JWT_SIGNING_SECRET must be set to a real value in production")
		}
		if isDevPlaceholder(c.SecretsMasterKey) {
			return errors.New("SECRETS_MASTER_KEY must be set to a real value in production")
		}
		if strings.HasPrefix(c.PublicURL, "http://") {
			return errors.New("CONTROL_PLANE_PUBLIC_URL must be https in production")
		}
	}
	return nil
}

// --- helpers ---

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func splitNonEmpty(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func parseDuration(key, def string) (time.Duration, error) {
	d, err := time.ParseDuration(getenv(key, def))
	if err != nil {
		return 0, fmt.Errorf("invalid duration for %s: %w", key, err)
	}
	return d, nil
}
