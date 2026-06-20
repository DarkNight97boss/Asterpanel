package api

import (
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

type impersonateRequest struct {
	TargetUserID string `json:"target_user_id"`
}

// handleStartImpersonation mints a short-lived access token that acts AS a target
// user, for support. Permitted only for a superadmin, or a reseller over a user
// in one of its own sub-accounts. It never targets a superadmin, never nests, and
// never runs from an API token; the real actor is preserved for the audit trail.
func (s *Server) handleStartImpersonation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := middleware.PrincipalFrom(ctx)
	if actor == nil || actor.IsAPIToken || actor.SessionID == uuid.Nil {
		httpx.Error(w, http.StatusForbidden, "forbidden", "impersonation requires an interactive session")
		return
	}
	if actor.ImpersonatorID.Valid {
		httpx.Error(w, http.StatusConflict, "already_impersonating", "stop the current impersonation first")
		return
	}
	var req impersonateRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	targetID, err := uuid.Parse(req.TargetUserID)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid target_user_id")
		return
	}
	if targetID == actor.UserID {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "cannot impersonate yourself")
		return
	}
	target, err := s.deps.Store.GetUserByID(ctx, targetID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "user not found")
		return
	}
	if target.IsSuperadmin {
		httpx.Error(w, http.StatusForbidden, "forbidden", "cannot impersonate a superadmin")
		return
	}
	if target.Status != "active" {
		httpx.Error(w, http.StatusConflict, "user_inactive", "target user is not active")
		return
	}
	mem, err := s.deps.Store.PrimaryMembership(ctx, target.ID)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "no_org", "target user has no organization")
		return
	}
	targetOrgID := mem.OrganizationID

	// Authorize: a superadmin may impersonate anyone; otherwise the target must
	// sit anywhere in the actor's reseller subtree (multi-tier — a master reaches
	// its sub-resellers' customers too, not just its direct sub-accounts).
	allowed := actor.Superadmin
	if !allowed {
		sub, serr := s.deps.Store.IsDescendantOf(ctx, targetOrgID, actor.OrgID)
		allowed = serr == nil && sub
	}
	if !allowed {
		a := actor.OrgID
		s.audit(ctx, &a, &actor.UserID, "auth.impersonate.start", "user", target.ID.String(), audit.OutcomeDenied, r,
			map[string]any{"target_user_id": target.ID.String()})
		httpx.Error(w, http.StatusForbidden, "forbidden", "not permitted to impersonate this user")
		return
	}

	now := time.Now()
	ua := r.UserAgent()
	ip := clientIP(r)
	sessionID, err := s.deps.Store.CreateSession(ctx, store.CreateSessionParams{
		UserID:    target.ID,
		OrgID:     uuid.NullUUID{UUID: targetOrgID, Valid: true},
		UserAgent: &ua,
		IP:        &ip,
		MFA:       true,
		ExpiresAt: now.Add(time.Hour), // the session outlives the short access token
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create session")
		return
	}
	access, err := s.deps.JWT.IssueImpersonation(target.ID, targetOrgID, sessionID, actor.UserID, now)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not issue token")
		return
	}

	a := actor.OrgID
	s.audit(ctx, &targetOrgID, &actor.UserID, "auth.impersonate.start", "user", target.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{
			"target_user_id": target.ID.String(),
			"target_org_id":  targetOrgID.String(),
			"actor_org_id":   a.String(),
			"session_id":     sessionID.String(),
		})

	httpx.JSON(w, http.StatusOK, map[string]any{
		"access_token":  access,
		"token_type":    "Bearer",
		"expires_in":    int(s.deps.JWT.TTL().Seconds()),
		"impersonating": true,
		"user":          userView(target, uuid.NullUUID{UUID: targetOrgID, Valid: true}),
	})
}

// handleStopImpersonation revokes the current impersonation session. It must be
// called with the impersonation token (its `act` claim present).
func (s *Server) handleStopImpersonation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	if p == nil || !p.ImpersonatorID.Valid {
		httpx.Error(w, http.StatusBadRequest, "not_impersonating", "no active impersonation")
		return
	}
	_ = s.deps.Store.RevokeSession(ctx, p.SessionID, "impersonation_end")
	org := p.OrgID
	actor := p.ImpersonatorID.UUID
	s.audit(ctx, &org, &actor, "auth.impersonate.stop", "user", p.UserID.String(), audit.OutcomeSuccess, r,
		map[string]any{"target_user_id": p.UserID.String(), "session_id": p.SessionID.String()})
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
