package api

import (
	"context"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

func contextWithTimeout(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// audit appends an entry, logging (never failing the request) on error.
func (s *Server) audit(ctx context.Context, org, user *uuid.UUID, action, resType, resID, outcome string, r *http.Request, meta map[string]any) {
	e := audit.Entry{
		OrganizationID: org,
		ActorUserID:    user,
		ActorType:      audit.ActorUser,
		Action:         action,
		ResourceType:   resType,
		ResourceID:     resID,
		Outcome:        outcome,
		IP:             clientIP(r),
		UserAgent:      r.UserAgent(),
		RequestID:      middleware.RequestIDFrom(ctx),
		Metadata:       meta,
	}
	if user == nil {
		e.ActorType = audit.ActorSystem
	}
	if err := s.deps.Audit.Append(ctx, e); err != nil {
		s.deps.Log.Error("audit append failed", "action", action, "error", err)
	}
}

// setAuthCookies sets the HttpOnly refresh cookie and the JS-readable CSRF cookie.
func (s *Server) setAuthCookies(w http.ResponseWriter, refreshToken, csrfToken string) {
	secure := s.deps.Cfg.IsProd()
	maxAge := int(s.deps.Cfg.RefreshTTL.Seconds())
	http.SetCookie(w, &http.Cookie{
		Name: "asterpanel_refresh", Value: refreshToken, Path: "/api/v1/auth",
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode, MaxAge: maxAge,
	})
	http.SetCookie(w, &http.Cookie{
		Name: middleware.CSRFCookieName, Value: csrfToken, Path: "/",
		HttpOnly: false, Secure: secure, SameSite: http.SameSiteStrictMode, MaxAge: maxAge,
	})
}

func (s *Server) clearAuthCookies(w http.ResponseWriter) {
	secure := s.deps.Cfg.IsProd()
	http.SetCookie(w, &http.Cookie{
		Name: "asterpanel_refresh", Value: "", Path: "/api/v1/auth",
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode, MaxAge: -1,
	})
	http.SetCookie(w, &http.Cookie{
		Name: middleware.CSRFCookieName, Value: "", Path: "/",
		HttpOnly: false, Secure: secure, SameSite: http.SameSiteStrictMode, MaxAge: -1,
	})
}

func ptr[T any](v T) *T { return &v }

// firstNode returns the first available node for an org (auto-placement), or nil.
func (s *Server) firstNode(ctx context.Context, orgID uuid.UUID) *store.ServerNode {
	nodes, err := s.deps.Store.ListNodes(ctx, orgID)
	if err != nil || len(nodes) == 0 {
		return nil
	}
	return &nodes[0]
}

// overQuota reports whether creating another `resource` (e.g. "sites",
// "domains") would exceed the org's billing-plan limit. No plan or a zero/absent
// limit means unlimited.
func (s *Server) overQuota(ctx context.Context, orgID uuid.UUID, resource string) (over bool, used, limit int) {
	_, limits, err := s.deps.Store.GetOrgPlanLimits(ctx, orgID)
	if err != nil || limits == nil {
		return false, 0, 0
	}
	limit = limits["max_"+resource]
	if limit <= 0 {
		return false, 0, 0
	}
	counts, err := s.deps.Store.UsageCounts(ctx, orgID)
	if err != nil {
		return false, 0, 0
	}
	used = counts[resource]
	return used >= limit, used, limit
}

func userView(u *store.User, orgID uuid.NullUUID) map[string]any {
	v := map[string]any{
		"id":         u.ID,
		"email":      u.Email,
		"full_name":  u.FullName,
		"superadmin": u.IsSuperadmin,
		"status":     u.Status,
	}
	if orgID.Valid {
		v["organization_id"] = orgID.UUID
	}
	return v
}
