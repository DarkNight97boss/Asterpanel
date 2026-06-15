package jobs

import (
	"crypto/ed25519"
	"testing"
	"time"

	"github.com/google/uuid"
)

func mustKeys(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	return pub, priv
}

func TestSignVerifyRoundTrip(t *testing.T) {
	pub, priv := mustKeys(t)
	signer := NewSigner(priv, "test-1")
	verifier := NewVerifier(pub)

	now := time.Date(2026, 6, 15, 10, 0, 0, 0, time.UTC)
	job, err := New(TypeWebsiteCreate, uuid.New(), uuid.New(),
		map[string]any{"domain": "example.com", "runtime": "static"}, 30*time.Second, now)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	body, sig, err := signer.Sign(job)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if err := verifier.Verify(body, sig); err != nil {
		t.Fatalf("Verify should succeed: %v", err)
	}

	// Tampering with the body must invalidate the signature.
	tampered := append([]byte(nil), body...)
	tampered[len(tampered)-2] ^= 0xFF
	if err := verifier.Verify(tampered, sig); err == nil {
		t.Fatal("Verify must fail on tampered body")
	}

	// A different public key must not verify.
	otherPub, _ := mustKeys(t)
	if err := NewVerifier(otherPub).Verify(body, sig); err == nil {
		t.Fatal("Verify must fail with a foreign key")
	}
}

func TestCanonicalDeterminism(t *testing.T) {
	now := time.Date(2026, 6, 15, 10, 0, 0, 0, time.UTC)
	id := uuid.New()
	node := uuid.New()
	tenant := uuid.New()

	mk := func() *Job {
		j, err := New(TypeAppDeploy, node, tenant,
			map[string]any{"b": 2, "a": 1, "nested": map[string]any{"z": true, "y": false}},
			30*time.Second, now)
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		j.ID = id // pin id so the two encodings are comparable
		j.Nonce = "fixed-nonce"
		return j
	}

	b1, err := mk().CanonicalBytes()
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	b2, err := mk().CanonicalBytes()
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	if string(b1) != string(b2) {
		t.Fatalf("canonical encoding must be deterministic:\n%s\n%s", b1, b2)
	}
}

func TestExpired(t *testing.T) {
	now := time.Date(2026, 6, 15, 10, 0, 0, 0, time.UTC)
	job, _ := New(TypeHealthCheck, uuid.New(), uuid.New(), map[string]any{}, 30*time.Second, now)
	if job.Expired(now.Add(10 * time.Second)) {
		t.Fatal("job should not be expired within TTL")
	}
	if !job.Expired(now.Add(31 * time.Second)) {
		t.Fatal("job should be expired after TTL")
	}
}
