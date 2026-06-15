// Package crypto holds the control plane's cryptographic primitives:
// Argon2id password hashing, AES-256-GCM envelope encryption for secrets at
// rest, Ed25519 key loading for job signing, and CSPRNG helpers.
package crypto

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
)

// RandomBytes returns n cryptographically-secure random bytes.
func RandomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

// RandomTokenURL returns a URL-safe, unpadded base64 token of n random bytes.
func RandomTokenURL(n int) (string, error) {
	b, err := RandomBytes(n)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// RandomHex returns a hex token of n random bytes (2n chars, no separators —
// safe to embed in underscore-delimited API tokens).
func RandomHex(n int) (string, error) {
	b, err := RandomBytes(n)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// SHA256 returns the SHA-256 digest of b. Used for hashing opaque tokens
// (refresh, API, enrollment) before they are stored — we never store the token.
func SHA256(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}
