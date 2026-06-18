// Package middleware holds the HTTP middleware chain: request id, recovery,
// security headers, CORS, rate limiting, authentication and authorization.
package middleware

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/authz"
)

type ctxKey int

const (
	keyRequestID ctxKey = iota
	keyPrincipal
)

// Principal is the authenticated caller for the current request.
type Principal struct {
	UserID      uuid.UUID
	OrgID       uuid.UUID
	SessionID   uuid.UUID
	Superadmin  bool
	IsAPIToken  bool
	TokenID     uuid.NullUUID
	Permissions authz.PermissionSet
	Scopes      []string
	// ImpersonatorID is the real actor's user id when this request runs under an
	// impersonation token (set from the JWT `act` claim).
	ImpersonatorID uuid.NullUUID
}

// Can reports whether the principal may perform an action. Superadmins bypass.
func (p *Principal) Can(permission string) bool {
	if p.Superadmin {
		return true
	}
	return p.Permissions.Has(permission)
}

func withPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, keyPrincipal, p)
}

// PrincipalFrom returns the authenticated principal, or nil.
func PrincipalFrom(ctx context.Context) *Principal {
	p, _ := ctx.Value(keyPrincipal).(*Principal)
	return p
}

func withRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, keyRequestID, id)
}

// RequestIDFrom returns the current request id.
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(keyRequestID).(string)
	return id
}

// clientIP extracts a best-effort client IP (first X-Forwarded-For hop, else
// RemoteAddr). The gateway is trusted to set XFF.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for i := 0; i < len(xff); i++ {
			if xff[i] == ',' {
				return trimSpace(xff[:i])
			}
		}
		return trimSpace(xff)
	}
	host := r.RemoteAddr
	for i := len(host) - 1; i >= 0; i-- {
		if host[i] == ':' {
			return host[:i]
		}
	}
	return host
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && s[start] == ' ' {
		start++
	}
	for end > start && s[end-1] == ' ' {
		end--
	}
	return s[start:end]
}
