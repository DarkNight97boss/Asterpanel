package middleware

import (
	"net/http"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/authz"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/logging"
)

// Authorizer enforces RBAC + OPA on a route. Order: principal present → RBAC
// permission held → OPA policy allows. Denials are audited.
type Authorizer struct {
	opa    *authz.OPAClient
	sink   audit.Sink
	strict bool // if true, OPA transport errors deny; if false they fall back to RBAC
}

func NewAuthorizer(opa *authz.OPAClient, sink audit.Sink, strict bool) *Authorizer {
	return &Authorizer{opa: opa, sink: sink, strict: strict}
}

// Require returns middleware that gates a route behind a permission + policy.
func (az *Authorizer) Require(permission, action, resourceType string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			p := PrincipalFrom(ctx)
			if p == nil {
				httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "authentication required")
				return
			}

			if !p.Can(permission) {
				az.deny(r, p, action, resourceType, "missing permission "+permission)
				httpx.Error(w, http.StatusForbidden, "forbidden", "insufficient permissions")
				return
			}

			input := map[string]any{
				"action":        action,
				"permission":    permission,
				"resource_type": resourceType,
				"subject": map[string]any{
					"user_id":      p.UserID.String(),
					"org_id":       p.OrgID.String(),
					"superadmin":   p.Superadmin,
					"is_api_token": p.IsAPIToken,
					"scopes":       p.Scopes,
					"permissions":  p.Permissions.Keys(),
				},
			}
			dec, err := az.opa.Authorize(ctx, input)
			if err != nil {
				if az.strict {
					az.deny(r, p, action, resourceType, "policy engine unavailable")
					httpx.Error(w, http.StatusForbidden, "forbidden", "policy decision unavailable")
					return
				}
				logging.From(ctx).Warn("opa unavailable; allowing on RBAC", "action", action, "error", err)
			} else if !dec.Allow {
				reason := "policy denied"
				if len(dec.Reasons) > 0 {
					reason = dec.Reasons[0]
				}
				az.deny(r, p, action, resourceType, reason)
				httpx.Error(w, http.StatusForbidden, "forbidden", "denied by policy")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func (az *Authorizer) deny(r *http.Request, p *Principal, action, resourceType, reason string) {
	ctx := r.Context()
	org := p.OrgID
	user := p.UserID
	entry := audit.Entry{
		OrganizationID: &org,
		ActorUserID:    &user,
		ActorType:      audit.ActorUser,
		Action:         action,
		ResourceType:   resourceType,
		Outcome:        audit.OutcomeDenied,
		IP:             clientIP(r),
		UserAgent:      r.UserAgent(),
		RequestID:      RequestIDFrom(ctx),
		Metadata:       map[string]any{"reason": reason},
	}
	if p.IsAPIToken {
		entry.ActorType = audit.ActorAPIToken
		entry.ActorTokenID = &p.TokenID.UUID
	}
	if err := az.sink.Append(ctx, entry); err != nil {
		logging.From(ctx).Error("audit append failed", "error", err)
	}
}
