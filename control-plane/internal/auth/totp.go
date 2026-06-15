package auth

import (
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

// TOTPConfig describes an enrolled authenticator.
type TOTPConfig struct {
	Secret    string // base32, stored envelope-encrypted at rest
	URL       string // otpauth:// provisioning URI for the QR code
	Digits    int
	Period    int
	Algorithm string
}

// GenerateTOTP creates a new TOTP secret + provisioning URI for a user.
func GenerateTOTP(issuer, account string) (*TOTPConfig, error) {
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      issuer,
		AccountName: account,
		Period:      30,
		Digits:      otp.DigitsSix,
		Algorithm:   otp.AlgorithmSHA1,
	})
	if err != nil {
		return nil, err
	}
	return &TOTPConfig{
		Secret:    key.Secret(),
		URL:       key.URL(),
		Digits:    6,
		Period:    30,
		Algorithm: "SHA1",
	}, nil
}

// ValidateTOTP checks a 6-digit passcode against a base32 secret with a small
// skew window (handled by the library).
func ValidateTOTP(passcode, secret string) bool {
	return totp.Validate(passcode, secret)
}
