package crypto

import (
	stdcrypto "crypto"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"time"
)

// CA is the project certificate authority used to sign agent certificates during
// enrollment. The key never leaves the control plane.
type CA struct {
	Cert    *x509.Certificate
	Key     stdcrypto.Signer
	certPEM []byte
}

// LoadCA loads the CA certificate and private key from PEM files.
func LoadCA(certPath, keyPath string) (*CA, error) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, err
	}
	cb, _ := pem.Decode(certPEM)
	if cb == nil {
		return nil, errors.New("crypto: no PEM block in CA certificate")
	}
	cert, err := x509.ParseCertificate(cb.Bytes)
	if err != nil {
		return nil, err
	}

	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, err
	}
	kb, _ := pem.Decode(keyPEM)
	if kb == nil {
		return nil, errors.New("crypto: no PEM block in CA key")
	}
	key, err := parseSigner(kb.Bytes)
	if err != nil {
		return nil, err
	}
	return &CA{Cert: cert, Key: key, certPEM: certPEM}, nil
}

func (c *CA) CertPEM() []byte { return c.certPEM }

// SignCSR validates and signs an agent's certificate signing request, producing
// a certificate usable for both client and server mTLS, valid for ttl.
func (c *CA) SignCSR(csrPEM []byte, commonName string, ttl time.Duration, now time.Time) (certPEM []byte, serial, fingerprint string, err error) {
	block, _ := pem.Decode(csrPEM)
	if block == nil {
		return nil, "", "", errors.New("crypto: no PEM block in CSR")
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		return nil, "", "", err
	}
	if err := csr.CheckSignature(); err != nil {
		return nil, "", "", fmt.Errorf("crypto: CSR signature invalid: %w", err)
	}

	serialNumber, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, "", "", err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serialNumber,
		Subject:               csr.Subject,
		NotBefore:             now.Add(-1 * time.Minute),
		NotAfter:              now.Add(ttl),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
		DNSNames:              csr.DNSNames,
		IPAddresses:           csr.IPAddresses,
		BasicConstraintsValid: true,
	}
	if commonName != "" {
		tmpl.Subject.CommonName = commonName
	}

	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.Cert, csr.PublicKey, c.Key)
	if err != nil {
		return nil, "", "", err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	sum := sha256.Sum256(der)
	return certPEM, serialNumber.Text(16), hex.EncodeToString(sum[:]), nil
}

func parseSigner(der []byte) (stdcrypto.Signer, error) {
	if k, err := x509.ParsePKCS8PrivateKey(der); err == nil {
		if s, ok := k.(stdcrypto.Signer); ok {
			return s, nil
		}
		return nil, errors.New("crypto: PKCS8 key is not a signer")
	}
	if k, err := x509.ParseECPrivateKey(der); err == nil {
		return k, nil
	}
	if k, err := x509.ParsePKCS1PrivateKey(der); err == nil {
		return k, nil
	}
	return nil, errors.New("crypto: unsupported CA private key format")
}
