package crypto

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
)

// LoadEd25519PrivateKeyPEM loads a PKCS#8 PEM Ed25519 private key, as produced
// by `openssl genpkey -algorithm ed25519`.
func LoadEd25519PrivateKeyPEM(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("crypto: no PEM block in private key file")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	priv, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("crypto: key is not Ed25519")
	}
	return priv, nil
}

// LoadEd25519PublicKeyPEM loads a SubjectPublicKeyInfo PEM Ed25519 public key,
// as produced by `openssl pkey -pubout`. The Rust agent reads the same file.
func LoadEd25519PublicKeyPEM(path string) (ed25519.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("crypto: no PEM block in public key file")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := pub.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("crypto: key is not Ed25519")
	}
	return key, nil
}
