package oidc

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"math/big"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func jwksFor(pub *rsa.PublicKey, kid string) *JWKS {
	return &JWKS{Keys: []JWK{{
		Kid: kid, Kty: "RSA",
		N: base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
		E: base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
	}}}
}

func TestValidateIDToken(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_700_000_000, 0)
	jwks := jwksFor(&key.PublicKey, "k1")

	mint := func(signer *rsa.PrivateKey, claims jwt.MapClaims) string {
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
		tok.Header["kid"] = "k1"
		s, serr := tok.SignedString(signer)
		if serr != nil {
			t.Fatal(serr)
		}
		return s
	}
	base := func() jwt.MapClaims {
		return jwt.MapClaims{
			"iss": "https://idp.example", "aud": "client123", "sub": "user-1",
			"email": "alice@acme.com", "email_verified": true, "nonce": "n1",
			"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
		}
	}

	// Happy path.
	c, err := ValidateIDToken(mint(key, base()), jwks, "https://idp.example", "client123", "n1", now)
	if err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	if c.Subject != "user-1" || c.Email != "alice@acme.com" || !c.EmailVerified {
		t.Fatalf("unexpected claims: %+v", c)
	}

	// Each of these MUST be rejected.
	type tc struct {
		name                      string
		raw                       string
		iss, aud, nonce           string
	}
	expired := base()
	expired["exp"] = now.Add(-time.Hour).Unix()
	other, _ := rsa.GenerateKey(rand.Reader, 2048)

	for _, c := range []tc{
		{"wrong nonce", mint(key, base()), "https://idp.example", "client123", "WRONG"},
		{"wrong audience", mint(key, base()), "https://idp.example", "attacker", "n1"},
		{"wrong issuer", mint(key, base()), "https://evil.example", "client123", "n1"},
		{"expired", mint(key, expired), "https://idp.example", "client123", "n1"},
		{"forged signature", mint(other, base()), "https://idp.example", "client123", "n1"},
	} {
		if _, err := ValidateIDToken(c.raw, jwks, c.iss, c.aud, c.nonce, now); err == nil {
			t.Errorf("%s: expected rejection, got none", c.name)
		}
	}
}

func TestS256ChallengeAndAuthURL(t *testing.T) {
	// Known RFC 7636 appendix B vector.
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	want := "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
	if got := S256Challenge(verifier); got != want {
		t.Fatalf("S256Challenge = %q, want %q", got, want)
	}

	meta := &Metadata{AuthorizationEndpoint: "https://idp.example/authorize"}
	u := AuthCodeURL(meta, "client123", "https://panel/cb", "state1", "nonce1", "chal1", []string{"openid", "email"})
	for _, sub := range []string{
		"response_type=code", "client_id=client123", "code_challenge=chal1",
		"code_challenge_method=S256", "state=state1", "nonce=nonce1", "scope=openid+email",
	} {
		if !contains(u, sub) {
			t.Errorf("auth url missing %q: %s", sub, u)
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
