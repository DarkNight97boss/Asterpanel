// Command signjob builds and Ed25519-signs an example job using the *real*
// control-plane signing code, then prints the canonical body, the signature, and
// a ready-to-run mTLS curl command that dispatches it to an agent. This is the
// runnable reference for the signed-job protocol (see examples/README.md).
package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
)

func main() {
	keyPath := flag.String("key", "secrets/job-signing/ed25519.key", "Ed25519 private key (PEM)")
	keyID := flag.String("key-id", "cp-dev-1", "signing key id")
	node := flag.String("node", "", "target node uuid (default: random)")
	tenant := flag.String("tenant", "", "tenant/org uuid (default: random)")
	agentURL := flag.String("agent", "https://localhost:7443", "agent base URL for the curl hint")
	flag.Parse()

	priv, err := crypto.LoadEd25519PrivateKeyPEM(*keyPath)
	if err != nil {
		fatal("load key: %v (run `make secrets` first)", err)
	}

	job, err := jobs.New(
		jobs.TypeWebsiteCreate,
		parseOrNew(*node),
		parseOrNew(*tenant),
		map[string]any{
			"website_id": uuid.New(),
			"name":       "demo",
			"domain":     "demo.example.com",
			"runtime":    "static",
			"ssl":        true,
		},
		30*time.Second,
		time.Now(),
	)
	if err != nil {
		fatal("build job: %v", err)
	}

	body, sig, err := jobs.NewSigner(priv, *keyID).Sign(job)
	if err != nil {
		fatal("sign: %v", err)
	}

	fmt.Println("# Canonical signed body (sign covers these exact bytes):")
	fmt.Println(string(body))
	fmt.Printf("\n# Signature: ed25519=%s\n", sig)
	fmt.Printf("\n# Dispatch over mTLS:\n")
	fmt.Printf(`curl -sS \
  --cert secrets/control-plane/client.crt \
  --key  secrets/control-plane/client.key \
  --cacert secrets/ca/ca.crt \
  -X POST %s/v1/jobs \
  -H 'Content-Type: application/json' \
  -H 'X-Asterpanel-Signature: ed25519=%s' \
  -H 'X-Asterpanel-Key-Id: %s' \
  --data-binary '%s'
`, *agentURL, sig, *keyID, string(body))
}

func parseOrNew(s string) uuid.UUID {
	if s == "" {
		return uuid.New()
	}
	id, err := uuid.Parse(s)
	if err != nil {
		fatal("invalid uuid %q: %v", s, err)
	}
	return id
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "signjob: "+format+"\n", args...)
	os.Exit(1)
}
