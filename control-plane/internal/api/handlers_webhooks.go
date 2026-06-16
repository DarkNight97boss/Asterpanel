package api

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

// KnownWebhookEvents is the catalog the UI uses to populate the event picker.
var KnownWebhookEvents = []string{
	"site.created", "site.deleted",
	"deploy.succeeded", "deploy.failed",
	"backup.created", "backup.failed",
	"invoice.created", "invoice.paid",
	"site.down", "site.recovered",
	"security.autoban",
}

// webhookView omits the secret on list/get; the full secret is shown ONCE on create.
func webhookView(h store.Webhook, includeSecret bool) map[string]any {
	v := map[string]any{
		"id":                h.ID,
		"url":               h.URL,
		"events":            h.Events,
		"active":            h.Active,
		"last_status":       h.LastStatus,
		"last_delivered_at": h.LastDeliveredAt,
		"created_at":        h.CreatedAt,
	}
	if includeSecret {
		v["secret"] = h.Secret
	} else if len(h.Secret) >= 8 {
		v["secret_preview"] = h.Secret[:4] + "…" + h.Secret[len(h.Secret)-4:]
	}
	return v
}

func (s *Server) handleListWebhooks(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	hooks, err := s.deps.Store.ListWebhooks(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list webhooks")
		return
	}
	views := make([]map[string]any, 0, len(hooks))
	for _, h := range hooks {
		views = append(views, webhookView(h, false))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"webhooks": views, "known_events": KnownWebhookEvents})
}

type createWebhookRequest struct {
	URL    string   `json:"url"`
	Events []string `json:"events"`
}

func (s *Server) handleCreateWebhook(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createWebhookRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	target := strings.TrimSpace(req.URL)
	u, perr := url.Parse(target)
	if perr != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "url must be a valid http(s) URL")
		return
	}
	secret, err := crypto.RandomTokenURL(32)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not generate secret")
		return
	}
	hook, err := s.deps.Store.CreateWebhook(ctx, store.CreateWebhookParams{
		OrgID: p.OrgID, URL: target, Secret: secret, Events: req.Events,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create webhook")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "webhook.create", "webhook", hook.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"url": target, "events": req.Events})
	// secret shown once
	httpx.JSON(w, http.StatusCreated, map[string]any{"webhook": webhookView(*hook, true)})
}

func (s *Server) handleDeleteWebhook(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "hookID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteWebhook(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "webhook not found")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "webhook.delete", "webhook", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// handleTestWebhook fires a synthetic webhook.test event so the customer can
// verify their endpoint receives and validates the HMAC signature.
func (s *Server) handleTestWebhook(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "hookID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	hook, err := s.deps.Store.GetWebhook(ctx, p.OrgID, id)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "webhook not found")
		return
	}
	if s.deps.Webhooks != nil {
		s.deps.Webhooks.Fire(ctx, p.OrgID, "webhook.test", map[string]any{"message": "It works."})
	}
	updated, _ := s.deps.Store.GetWebhook(ctx, p.OrgID, id)
	if updated == nil {
		updated = hook
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"webhook": webhookView(*updated, false)})
}
