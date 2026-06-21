// Package config loads the billing service's settings from the environment.
package config

import "os"

type Config struct {
	ListenAddr string // where the billing API listens
	// The default hosting backend the billing panel provisions on. The billing
	// product is backend-agnostic; these point its built-in AsterPanel module at
	// a control plane. Additional backends (cPanel, Plesk) get their own config.
	HostingBackend  string // "asterpanel" (the registered module to use by default)
	HostingBaseURL  string // control-plane root, e.g. https://panel.example.com
	HostingAPIToken string // reseller-scoped API token for that control plane
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// Load reads configuration from the environment with sane defaults.
func Load() Config {
	return Config{
		ListenAddr:      env("BILLING_LISTEN_ADDR", ":8090"),
		HostingBackend:  env("BILLING_HOSTING_BACKEND", "asterpanel"),
		HostingBaseURL:  env("BILLING_HOSTING_BASE_URL", "http://localhost:8080"),
		HostingAPIToken: os.Getenv("BILLING_HOSTING_API_TOKEN"),
	}
}
