package crypto

import "testing"

func TestPasswordHashVerify(t *testing.T) {
	const pw = "ChangeMe!123-correct horse"
	hash, err := HashPassword(pw)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if len(hash) < 20 || hash[:9] != "$argon2id" {
		t.Fatalf("unexpected hash format: %q", hash)
	}

	ok, err := VerifyPassword(pw, hash)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !ok {
		t.Fatal("correct password must verify")
	}

	ok, err = VerifyPassword("wrong password", hash)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if ok {
		t.Fatal("wrong password must not verify")
	}
}

func TestEnvelopeRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	env, err := NewEnvelope(key, "k1")
	if err != nil {
		t.Fatalf("envelope: %v", err)
	}
	plaintext := []byte("super-secret-value")
	aad := []byte("org:123|key:DB_PASSWORD")

	ct, nonce, err := env.Encrypt(plaintext, aad)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	got, err := env.Decrypt(ct, nonce, aad)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if string(got) != string(plaintext) {
		t.Fatalf("roundtrip mismatch: %q", got)
	}

	// Wrong AAD must fail authentication (ciphertext can't be moved between rows).
	if _, err := env.Decrypt(ct, nonce, []byte("org:999|key:OTHER")); err == nil {
		t.Fatal("decrypt with wrong AAD must fail")
	}
}
