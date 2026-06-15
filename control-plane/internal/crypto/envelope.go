package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
)

// Envelope provides authenticated encryption (AES-256-GCM) for sensitive values
// stored at rest (the `secrets` and `totp_secrets` tables). In production the
// data key is unsealed from Vault/SOPS; in dev it comes from SECRETS_MASTER_KEY.
type Envelope struct {
	aead  cipher.AEAD
	keyID string
}

// NewEnvelope builds an Envelope from a 32-byte key.
func NewEnvelope(key []byte, keyID string) (*Envelope, error) {
	if len(key) != 32 {
		return nil, errors.New("crypto: envelope key must be 32 bytes (AES-256)")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Envelope{aead: aead, keyID: keyID}, nil
}

func (e *Envelope) KeyID() string { return e.keyID }

// Encrypt seals plaintext, binding it to aad (additional authenticated data,
// e.g. the secret's tenant+key so ciphertext cannot be swapped between rows).
// Returns the ciphertext and the random nonce used.
func (e *Envelope) Encrypt(plaintext, aad []byte) (ciphertext, nonce []byte, err error) {
	nonce = make([]byte, e.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	ciphertext = e.aead.Seal(nil, nonce, plaintext, aad)
	return ciphertext, nonce, nil
}

// Decrypt opens ciphertext produced by Encrypt with the same aad.
func (e *Envelope) Decrypt(ciphertext, nonce, aad []byte) ([]byte, error) {
	if len(nonce) != e.aead.NonceSize() {
		return nil, errors.New("crypto: bad nonce length")
	}
	return e.aead.Open(nil, nonce, ciphertext, aad)
}
