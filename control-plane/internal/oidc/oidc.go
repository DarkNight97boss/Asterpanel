// Package oidc implements the slice of OpenID Connect the panel needs to log a
// user in via an external IdP: discovery, the Authorization Code flow with PKCE,
// and — the security-critical part — validation of the IdP's signed ID token
// (RS256 verified against the issuer's JWKS, with iss / aud / exp / nonce checks).
//
// The validation entrypoint (ValidateIDToken) is pure: it takes the JWKS and the
// current time as arguments, so it is fully unit-testable without any network.
package oidc

import (
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Metadata is the subset of the IdP's discovery document we use.
type Metadata struct {
	Issuer                string `json:"issuer"`
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	JWKSURI               string `json:"jwks_uri"`
}

// Discover fetches {issuer}/.well-known/openid-configuration and verifies the
// returned issuer matches (per the OIDC discovery spec) to prevent mix-ups.
func Discover(ctx context.Context, client *http.Client, issuer string) (*Metadata, error) {
	endpoint := strings.TrimRight(issuer, "/") + "/.well-known/openid-configuration"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("oidc: discovery returned %d", resp.StatusCode)
	}
	var m Metadata
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&m); err != nil {
		return nil, err
	}
	if m.Issuer != issuer {
		return nil, fmt.Errorf("oidc: issuer mismatch (configured %q, document %q)", issuer, m.Issuer)
	}
	if m.AuthorizationEndpoint == "" || m.TokenEndpoint == "" || m.JWKSURI == "" {
		return nil, errors.New("oidc: discovery document missing endpoints")
	}
	return &m, nil
}

// S256Challenge derives the PKCE code_challenge (S256) from a code_verifier.
func S256Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// AuthCodeURL builds the authorization redirect: Authorization Code flow with
// PKCE (S256), an anti-CSRF state and a replay-binding nonce.
func AuthCodeURL(meta *Metadata, clientID, redirectURI, state, nonce, codeChallenge string, scopes []string) string {
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", clientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("scope", strings.Join(scopes, " "))
	q.Set("state", state)
	q.Set("nonce", nonce)
	q.Set("code_challenge", codeChallenge)
	q.Set("code_challenge_method", "S256")
	sep := "?"
	if strings.Contains(meta.AuthorizationEndpoint, "?") {
		sep = "&"
	}
	return meta.AuthorizationEndpoint + sep + q.Encode()
}

// ExchangeCode redeems the authorization code at the token endpoint and returns
// the raw (still-to-be-validated) ID token.
func ExchangeCode(ctx context.Context, client *http.Client, meta *Metadata, clientID, clientSecret, code, redirectURI, codeVerifier string) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	form.Set("client_id", clientID)
	form.Set("client_secret", clientSecret)
	form.Set("code_verifier", codeVerifier)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, meta.TokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("oidc: token endpoint returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var tr struct {
		IDToken string `json:"id_token"`
	}
	if err := json.Unmarshal(body, &tr); err != nil {
		return "", err
	}
	if tr.IDToken == "" {
		return "", errors.New("oidc: token response had no id_token")
	}
	return tr.IDToken, nil
}

// JWK / JWKS model the public keys published at the issuer's jwks_uri.
type JWK struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type JWKS struct {
	Keys []JWK `json:"keys"`
}

func (s *JWKS) find(kid string) *JWK {
	for i := range s.Keys {
		if s.Keys[i].Kid == kid {
			return &s.Keys[i]
		}
	}
	// A token without a kid is allowed only when the set has exactly one key.
	if kid == "" && len(s.Keys) == 1 {
		return &s.Keys[0]
	}
	return nil
}

func (k *JWK) rsaPublicKey() (*rsa.PublicKey, error) {
	if k.Kty != "RSA" {
		return nil, fmt.Errorf("oidc: unsupported key type %q", k.Kty)
	}
	nb, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		return nil, fmt.Errorf("oidc: bad modulus: %w", err)
	}
	eb, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		return nil, fmt.Errorf("oidc: bad exponent: %w", err)
	}
	e := 0
	for _, b := range eb {
		e = e<<8 + int(b)
	}
	if e == 0 {
		return nil, errors.New("oidc: zero exponent")
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nb), E: e}, nil
}

// FetchJWKS downloads the issuer's signing keys.
func FetchJWKS(ctx context.Context, client *http.Client, jwksURI string) (*JWKS, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, jwksURI, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("oidc: jwks returned %d", resp.StatusCode)
	}
	var ks JWKS
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&ks); err != nil {
		return nil, err
	}
	if len(ks.Keys) == 0 {
		return nil, errors.New("oidc: empty JWKS")
	}
	return &ks, nil
}

// Claims is the validated subset of the ID token we trust.
type Claims struct {
	Subject       string
	Email         string
	EmailVerified bool
}

// ValidateIDToken verifies the ID token's RS256 signature against the JWKS and
// checks issuer, audience, expiry and the replay-binding nonce. It is pure (no
// I/O): pass the fetched JWKS and the current time. Returns the trusted claims.
func ValidateIDToken(raw string, jwks *JWKS, issuer, clientID, expectedNonce string, now time.Time) (*Claims, error) {
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(issuer),
		jwt.WithAudience(clientID),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(func() time.Time { return now }),
	)
	claims := jwt.MapClaims{}
	_, err := parser.ParseWithClaims(raw, claims, func(t *jwt.Token) (interface{}, error) {
		kid, _ := t.Header["kid"].(string)
		key := jwks.find(kid)
		if key == nil {
			return nil, errors.New("oidc: no JWKS key for token kid")
		}
		return key.rsaPublicKey()
	})
	if err != nil {
		return nil, err
	}
	// Bind the token to the nonce we issued at /start (replay protection).
	if expectedNonce != "" {
		if n, _ := claims["nonce"].(string); n != expectedNonce {
			return nil, errors.New("oidc: nonce mismatch")
		}
	}
	sub, _ := claims["sub"].(string)
	if sub == "" {
		return nil, errors.New("oidc: id token missing subject")
	}
	email, _ := claims["email"].(string)
	ev, _ := claims["email_verified"].(bool)
	return &Claims{Subject: sub, Email: email, EmailVerified: ev}, nil
}
