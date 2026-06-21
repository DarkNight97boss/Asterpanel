// Command billing is the entrypoint for Aster Billing — a standalone billing &
// automation product (a WHMCS alternative) that drives one or more hosting
// control panels through the pluggable hosting.Backend seam. It is a separate
// service from the AsterPanel control plane and talks to it only over the API.
package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/DarkNight97boss/asterpanel/billing-plane/internal/config"
	"github.com/DarkNight97boss/asterpanel/billing-plane/internal/hosting"
)

func main() {
	cfg := config.Load()

	// Register the hosting backends this deployment can provision on. AsterPanel
	// is built in; cPanel/Plesk modules register here too once they exist.
	reg := hosting.NewRegistry()
	reg.Register(hosting.NewAsterPanel(cfg.HostingBaseURL, cfg.HostingAPIToken))

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	// /readyz reports which hosting backends are wired up — the integration seam.
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"service":          "aster-billing",
			"default_backend":  cfg.HostingBackend,
			"hosting_backends": reg.Names(),
		})
	})

	log.Printf("aster-billing listening on %s (hosting backends: %v, default: %s)",
		cfg.ListenAddr, reg.Names(), cfg.HostingBackend)
	if err := http.ListenAndServe(cfg.ListenAddr, mux); err != nil {
		log.Fatalf("billing server stopped: %v", err)
	}
}
