package jobs

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
)

// Signer signs jobs with the control plane's Ed25519 private key.
type Signer struct {
	priv  ed25519.PrivateKey
	keyID string
}

func NewSigner(priv ed25519.PrivateKey, keyID string) *Signer {
	return &Signer{priv: priv, keyID: keyID}
}

func (s *Signer) KeyID() string { return s.keyID }

// Sign returns the canonical body that must be transmitted verbatim and the
// base64 Ed25519 signature over that exact body.
func (s *Signer) Sign(j *Job) (body []byte, signatureB64 string, err error) {
	body, err = j.CanonicalBytes()
	if err != nil {
		return nil, "", err
	}
	sig := ed25519.Sign(s.priv, body)
	return body, base64.StdEncoding.EncodeToString(sig), nil
}

// Verifier checks job signatures with the control plane's public key. The agent
// uses the equivalent in Rust; this is kept here for the example tooling/tests.
type Verifier struct {
	pub ed25519.PublicKey
}

func NewVerifier(pub ed25519.PublicKey) *Verifier { return &Verifier{pub: pub} }

var ErrBadSignature = errors.New("jobs: invalid signature")

// Verify checks signatureB64 over the exact body bytes received.
func (v *Verifier) Verify(body []byte, signatureB64 string) error {
	sig, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return ErrBadSignature
	}
	if !ed25519.Verify(v.pub, body, sig) {
		return ErrBadSignature
	}
	return nil
}
