package licensing

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
	"time"
)

func TestSignVerifyAndGating(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	now := time.Date(2026, 6, 16, 0, 0, 0, 0, time.UTC)
	exp := now.AddDate(1, 0, 0)

	token, err := Sign(License{
		Edition: EditionPro, IssuedTo: "Acme",
		Features: []string{FeatureReseller, FeatureBilling},
		Limits:   map[string]int{"max_nodes": 5},
		IssuedAt: now, ExpiresAt: &exp,
	}, priv)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	m, err := Load(token, pubB64, now)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if m.Edition() != EditionPro {
		t.Fatalf("edition = %s", m.Edition())
	}
	if !m.Has(FeatureReseller) || !m.Has(FeatureBilling) {
		t.Fatal("expected reseller+billing")
	}
	if m.Has(FeatureWhiteLabel) {
		t.Fatal("white_label should be absent")
	}
	// no multi_node feature → capped at 1 even though limit says 5
	if m.MaxNodes() != 1 {
		t.Fatalf("max nodes without multi_node = %d", m.MaxNodes())
	}
}

func TestMultiNodeLimit(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now().UTC()
	tok, _ := Sign(License{Edition: EditionPro, Features: []string{FeatureMultiNode}, Limits: map[string]int{"max_nodes": 3}, IssuedAt: now}, priv)
	m, _ := Load(tok, base64.StdEncoding.EncodeToString(pub), now)
	if m.MaxNodes() != 3 {
		t.Fatalf("max nodes = %d, want 3", m.MaxNodes())
	}
}

func TestFailClosedToCommunity(t *testing.T) {
	now := time.Now().UTC()
	// empty token/key → community
	m, err := Load("", "", now)
	if err != nil || !m.IsCommunity() || m.MaxNodes() != 1 || m.Has(FeatureReseller) {
		t.Fatalf("empty should be community: err=%v", err)
	}

	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	pubB64 := base64.StdEncoding.EncodeToString(pub)

	// tampered signature → community + ErrSignature
	tok, _ := Sign(License{Edition: EditionPro, Features: []string{FeatureReseller}, IssuedAt: now}, priv)
	parts := []byte(tok)
	parts[len(parts)-1] ^= 0x01 // flip a bit in the signature
	m, err = Load(string(parts), pubB64, now)
	if err == nil || !m.IsCommunity() {
		t.Fatal("tampered token must fail closed to community")
	}

	// expired → community + ErrExpired
	past := now.AddDate(-1, 0, 0)
	tok2, _ := Sign(License{Edition: EditionPro, Features: []string{FeatureReseller}, IssuedAt: past, ExpiresAt: &past}, priv)
	m, err = Load(tok2, pubB64, now)
	if err != ErrExpired || !m.IsCommunity() {
		t.Fatalf("expired must fail closed: err=%v", err)
	}

	// wrong public key → community
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	goodTok, _ := Sign(License{Edition: EditionPro, IssuedAt: now}, priv)
	m, err = Load(goodTok, base64.StdEncoding.EncodeToString(otherPub), now)
	if err != ErrSignature || !m.IsCommunity() {
		t.Fatalf("wrong key must fail closed: err=%v", err)
	}
}
