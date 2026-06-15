package config

import (
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"os"
)

// decodeKey decodes a base64 (std or url, with/without padding) env value and
// asserts the decoded length. Used for symmetric keys that must be exact-width.
func decodeKey(envKey string, wantLen int) ([]byte, error) {
	raw := os.Getenv(envKey)
	if raw == "" {
		// Allow empty in dev; validate() enforces presence in prod.
		return make([]byte, wantLen), nil
	}
	for _, enc := range []*base64.Encoding{
		base64.StdEncoding, base64.RawStdEncoding,
		base64.URLEncoding, base64.RawURLEncoding,
	} {
		if b, err := enc.DecodeString(raw); err == nil {
			if len(b) != wantLen {
				return nil, fmt.Errorf("%s must decode to %d bytes, got %d", envKey, wantLen, len(b))
			}
			return b, nil
		}
	}
	return nil, fmt.Errorf("%s is not valid base64", envKey)
}

// isDevPlaceholder reports whether a key is all-zero (the dev placeholder).
func isDevPlaceholder(key []byte) bool {
	zero := make([]byte, len(key))
	return subtle.ConstantTimeCompare(key, zero) == 1
}
