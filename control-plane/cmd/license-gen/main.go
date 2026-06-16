// Command license-gen is the vendor's offline tool to mint signed AsterPanel
// licenses. Keep the private key SECRET — anyone holding it can issue Pro
// licenses for a control plane configured with the matching public key.
//
//	license-gen keygen
//	license-gen sign -key <privB64> -to "Acme Hosting" -features reseller,white_label,billing,migration,multi_node -max-nodes 10 -days 365
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/licensing"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "keygen":
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			die(err.Error())
		}
		fmt.Println("# Public key — set on the control plane as ASTERPANEL_LICENSE_PUBKEY:")
		fmt.Println(base64.StdEncoding.EncodeToString(pub))
		fmt.Println("# Private key — KEEP SECRET (pass to `license-gen sign -key ...`):")
		fmt.Println(base64.StdEncoding.EncodeToString(priv))
	case "sign":
		fs := flag.NewFlagSet("sign", flag.ExitOnError)
		keyB64 := fs.String("key", os.Getenv("LICENSE_SIGNING_KEY"), "base64 Ed25519 private key (or $LICENSE_SIGNING_KEY)")
		edition := fs.String("edition", licensing.EditionPro, "edition: pro|enterprise")
		to := fs.String("to", "", "issued-to (customer name)")
		features := fs.String("features", strings.Join(licensing.KnownFeatures, ","), "comma-separated features")
		maxNodes := fs.Int("max-nodes", 0, "node cap (0 = unlimited)")
		days := fs.Int("days", 365, "validity in days (0 = perpetual)")
		_ = fs.Parse(os.Args[2:])

		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(*keyB64))
		if err != nil || len(raw) != ed25519.PrivateKeySize {
			die("invalid private key (need a base64 Ed25519 private key from `keygen`)")
		}
		lic := licensing.License{
			Edition:  *edition,
			IssuedTo: *to,
			Features: splitNonEmpty(*features),
			Limits:   map[string]int{"max_nodes": *maxNodes},
			IssuedAt: time.Now().UTC(),
		}
		if *days > 0 {
			exp := time.Now().UTC().AddDate(0, 0, *days)
			lic.ExpiresAt = &exp
		}
		token, err := licensing.Sign(lic, ed25519.PrivateKey(raw))
		if err != nil {
			die(err.Error())
		}
		fmt.Println(token)
	default:
		usage()
	}
}

func splitNonEmpty(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage:\n  license-gen keygen\n  license-gen sign -key <privB64> -to <name> [-features a,b] [-max-nodes N] [-days N]")
	os.Exit(2)
}

func die(msg string) {
	fmt.Fprintln(os.Stderr, "error:", msg)
	os.Exit(1)
}
