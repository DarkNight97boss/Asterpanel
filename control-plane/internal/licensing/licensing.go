// Package licensing implements AsterPanel's open-core entitlement system.
//
// All code ships in the public repository, but the **commercial layer**
// (reseller, white-label, billing, migration, multi-node) only unlocks with a
// valid Ed25519-signed license. The signing private key is held solely by the
// vendor; the control plane verifies licenses with a public key supplied at
// runtime (ASTERPANEL_LICENSE_PUBKEY). With no/invalid license the panel runs
// the limited Community edition — it fails *closed* to free, never crashes.
package licensing

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const (
	EditionCommunity  = "community"
	EditionPro        = "pro"
	EditionEnterprise = "enterprise"
)

// Premium features — the commercial layer. Community has none of these.
const (
	FeatureReseller   = "reseller"
	FeatureWhiteLabel = "white_label"
	FeatureBilling    = "billing"
	FeatureMigration  = "migration"
	FeatureMultiNode  = "multi_node"
)

// KnownFeatures is the catalog the UI uses to render locked/unlocked state.
var KnownFeatures = []string{
	FeatureReseller, FeatureWhiteLabel, FeatureBilling, FeatureMigration, FeatureMultiNode,
}

type License struct {
	Edition   string         `json:"edition"`
	IssuedTo  string         `json:"issued_to"`
	Features  []string       `json:"features"`
	Limits    map[string]int `json:"limits"`
	IssuedAt  time.Time      `json:"issued_at"`
	ExpiresAt *time.Time     `json:"expires_at"`
}

var (
	ErrMalformed = errors.New("license: malformed token")
	ErrSignature = errors.New("license: invalid signature")
	ErrExpired   = errors.New("license: expired")
)

// Sign produces a compact license token `payloadB64.sigB64`, signed over the
// base64 payload string (no canonicalization needed).
func Sign(lic License, priv ed25519.PrivateKey) (string, error) {
	payload, err := json.Marshal(lic)
	if err != nil {
		return "", err
	}
	p := base64.RawURLEncoding.EncodeToString(payload)
	sig := ed25519.Sign(priv, []byte(p))
	return p + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// Verify validates a license token against the public key and expiry.
func Verify(token string, pub ed25519.PublicKey, now time.Time) (*License, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, ErrMalformed
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrMalformed
	}
	if !ed25519.Verify(pub, []byte(parts[0]), sig) {
		return nil, ErrSignature
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, ErrMalformed
	}
	var lic License
	if err := json.Unmarshal(payload, &lic); err != nil {
		return nil, ErrMalformed
	}
	if lic.ExpiresAt != nil && now.After(*lic.ExpiresAt) {
		return nil, ErrExpired
	}
	return &lic, nil
}

// Manager answers entitlement questions; a nil license means Community.
type Manager struct {
	lic *License
}

// Community returns a Community-edition Manager (no premium features).
func Community() *Manager { return &Manager{} }

// Load builds a Manager from a license token + base64 public key. Any problem
// (empty, malformed, bad key/signature, expired) yields Community + the error
// for logging — it never returns nil.
func Load(token, pubkeyB64 string, now time.Time) (*Manager, error) {
	if strings.TrimSpace(token) == "" || strings.TrimSpace(pubkeyB64) == "" {
		return &Manager{}, nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(pubkeyB64))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return &Manager{}, errors.New("license: invalid public key")
	}
	lic, err := Verify(token, ed25519.PublicKey(raw), now)
	if err != nil {
		return &Manager{}, err
	}
	return &Manager{lic: lic}, nil
}

func (m *Manager) Edition() string {
	if m.lic == nil {
		return EditionCommunity
	}
	return m.lic.Edition
}

func (m *Manager) IsCommunity() bool { return m.lic == nil }

// Has reports whether the current license includes a premium feature.
func (m *Manager) Has(feature string) bool {
	if m.lic == nil {
		return false
	}
	for _, f := range m.lic.Features {
		if f == feature {
			return true
		}
	}
	return false
}

func (m *Manager) Features() []string {
	if m.lic == nil || m.lic.Features == nil {
		return []string{}
	}
	return m.lic.Features
}

// MaxNodes is the node cap (0 = unlimited). Community (or Pro without the
// multi_node feature) is capped at 1.
func (m *Manager) MaxNodes() int {
	if m.lic == nil || !m.Has(FeatureMultiNode) {
		return 1
	}
	if n, ok := m.lic.Limits["max_nodes"]; ok && n > 0 {
		return n
	}
	return 0
}

func (m *Manager) Info() map[string]any {
	var issuedTo string
	var expires *time.Time
	if m.lic != nil {
		issuedTo = m.lic.IssuedTo
		expires = m.lic.ExpiresAt
	}
	return map[string]any{
		"edition":    m.Edition(),
		"features":   m.Features(),
		"max_nodes":  m.MaxNodes(),
		"issued_to":  issuedTo,
		"expires_at": expires,
	}
}
