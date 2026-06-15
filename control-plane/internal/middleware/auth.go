package middleware

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/auth"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/authz"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

// Authenticator resolves the request Principal from a bearer credential: either
// a short-lived access JWT or a scoped API token (prefixed "astp_").
type Authenticator struct {
	store *store.Store
	jwt   *auth.JWTIssuer
}

func NewAuthenticator(s *store.Store, jwt *auth.JWTIssuer) *Authenticator {
	return &Authenticator{store: s, jwt: jwt}
}

const apiTokenPrefix = "astp_"

// Middleware authenticates the request or returns 401.
func (a *Authenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := bearer(r)
		if raw == "" {
			httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "missing bearer token")
			return
		}

		var (
			principal *Principal
			err       error
		)
		if strings.HasPrefix(raw, apiTokenPrefix) {
			principal, err = a.fromAPIToken(r, raw)
		} else {
			principal, err = a.fromJWT(r, raw)
		}
		if err != nil || principal == nil {
			httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "invalid or expired credentials")
			return
		}
		next.ServeHTTP(w, r.WithContext(withPrincipal(r.Context(), principal)))
	})
}

func (a *Authenticator) fromJWT(r *http.Request, raw string) (*Principal, error) {
	ctx := r.Context()
	claims, err := a.jwt.Parse(raw)
	if err != nil {
		return nil, err
	}
	// Coarse revocation: the session must still be active.
	active, err := a.store.IsSessionActive(ctx, claims.SessionID)
	if err != nil || !active {
		return nil, errUnauthenticated
	}
	perms, err := a.store.PermissionKeysForUserOrg(ctx, claims.UserID, claims.OrgID)
	if err != nil {
		return nil, err
	}
	return &Principal{
		UserID:      claims.UserID,
		OrgID:       claims.OrgID,
		SessionID:   claims.SessionID,
		Superadmin:  claims.Superadmin,
		Permissions: authz.NewPermissionSet(perms),
	}, nil
}

func (a *Authenticator) fromAPIToken(r *http.Request, raw string) (*Principal, error) {
	ctx := r.Context()
	// Format: astp_<prefix>_<secret>
	parts := strings.SplitN(raw, "_", 3)
	if len(parts) != 3 || parts[0] != "astp" {
		return nil, errUnauthenticated
	}
	row, err := a.store.GetAPITokenByPrefix(ctx, parts[1])
	if err != nil {
		return nil, err
	}
	if row.Revoked || row.Expired {
		return nil, errUnauthenticated
	}
	if subtle.ConstantTimeCompare(crypto.SHA256([]byte(raw)), row.TokenHash) != 1 {
		return nil, errUnauthenticated
	}
	_ = a.store.TouchAPIToken(ctx, row.ID)

	userID := uuid.Nil
	if row.UserID.Valid {
		userID = row.UserID.UUID
	}
	return &Principal{
		UserID:      userID,
		OrgID:       row.OrgID,
		IsAPIToken:  true,
		TokenID:     uuid.NullUUID{UUID: row.ID, Valid: true},
		Permissions: authz.NewPermissionSet(row.Scopes),
		Scopes:      row.Scopes,
	}, nil
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const p = "Bearer "
	if len(h) > len(p) && strings.EqualFold(h[:len(p)], p) {
		return strings.TrimSpace(h[len(p):])
	}
	return ""
}

var errUnauthenticated = &authError{"unauthenticated"}

type authError struct{ msg string }

func (e *authError) Error() string { return e.msg }
