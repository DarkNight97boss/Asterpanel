// Package auth implements token issuance/validation, refresh-token rotation,
// and second factors (TOTP/WebAuthn) for the control plane.
package auth

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// Claims is the access-token payload. Access tokens are short-lived and carry
// just enough to authorize a request without a DB hit on the hot path; coarse
// revocation is enforced via the session id + short TTL.
type Claims struct {
	jwt.RegisteredClaims
	UserID     uuid.UUID `json:"uid"`
	OrgID      uuid.UUID `json:"org"`
	SessionID  uuid.UUID `json:"sid"`
	MFA        bool      `json:"mfa"`
	Scopes     []string  `json:"scopes,omitempty"`
	Superadmin bool      `json:"sa,omitempty"`
	// Act is the real actor (impersonator) user id when this token was minted via
	// impersonation — RFC 8693-style delegation, preserved for the audit trail.
	Act string `json:"act,omitempty"`
}

// JWTIssuer signs and validates access tokens (HS256 in dev; swap for an
// asymmetric key/JWKS in production without touching callers).
type JWTIssuer struct {
	secret   []byte
	issuer   string
	audience string
	ttl      time.Duration
}

func NewJWTIssuer(secret []byte, issuer, audience string, ttl time.Duration) *JWTIssuer {
	return &JWTIssuer{secret: secret, issuer: issuer, audience: audience, ttl: ttl}
}

func (j *JWTIssuer) TTL() time.Duration { return j.ttl }

// Issue mints an access token for a session.
func (j *JWTIssuer) Issue(userID, orgID, sessionID uuid.UUID, mfa, superadmin bool, scopes []string, now time.Time) (string, error) {
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    j.issuer,
			Subject:   userID.String(),
			Audience:  jwt.ClaimStrings{j.audience},
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(j.ttl)),
			ID:        uuid.NewString(),
		},
		UserID:     userID,
		OrgID:      orgID,
		SessionID:  sessionID,
		MFA:        mfa,
		Superadmin: superadmin,
		Scopes:     scopes,
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(j.secret)
}

// IssueImpersonation mints a short-lived access token that acts AS targetUserID
// in targetOrgID, recording the real actor in the `act` claim for audit. The
// token never carries superadmin — the impersonator sees only what the target's
// own role permits.
func (j *JWTIssuer) IssueImpersonation(targetUserID, targetOrgID, sessionID, actorID uuid.UUID, now time.Time) (string, error) {
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    j.issuer,
			Subject:   targetUserID.String(),
			Audience:  jwt.ClaimStrings{j.audience},
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(j.ttl)),
			ID:        uuid.NewString(),
		},
		UserID:    targetUserID,
		OrgID:     targetOrgID,
		SessionID: sessionID,
		MFA:       true,
		Act:       actorID.String(),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(j.secret)
}

var ErrInvalidToken = errors.New("auth: invalid token")

// Parse validates a token's signature, issuer, audience and expiry.
func (j *JWTIssuer) Parse(tokenStr string) (*Claims, error) {
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, ErrInvalidToken
		}
		return j.secret, nil
	},
		jwt.WithValidMethods([]string{"HS256"}),
		jwt.WithIssuer(j.issuer),
		jwt.WithAudience(j.audience),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return nil, errors.Join(ErrInvalidToken, err)
	}
	return claims, nil
}
