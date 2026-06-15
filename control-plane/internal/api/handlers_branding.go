package api

import (
	"net/http"
	"strings"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

const (
	defaultPanelName    = "AsterPanel"
	defaultPrimaryColor = "#6366f1"
)

// isHexColor validates a #rrggbb color — branding values theme the panel, so an
// invalid one must never reach the CSS.
func isHexColor(s string) bool {
	if len(s) != 7 || s[0] != '#' {
		return false
	}
	for _, c := range s[1:] {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func strOr(p *string, def string) string {
	if p != nil && *p != "" {
		return *p
	}
	return def
}

func brandingView(b *store.Branding) map[string]any {
	if b == nil {
		b = &store.Branding{}
	}
	color := strOr(b.PrimaryColor, defaultPrimaryColor)
	if !isHexColor(color) {
		color = defaultPrimaryColor
	}
	return map[string]any{
		"panel_name":    strOr(b.PanelName, defaultPanelName),
		"logo_url":      strOr(b.LogoURL, ""),
		"primary_color": color,
		"support_email": strOr(b.SupportEmail, ""),
		"support_url":   strOr(b.SupportURL, ""),
	}
}

func (s *Server) handleGetBranding(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	b, err := s.deps.Store.GetEffectiveBranding(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not load branding")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"branding": brandingView(b)})
}

type brandingRequest struct {
	PanelName    string `json:"panel_name"`
	LogoURL      string `json:"logo_url"`
	PrimaryColor string `json:"primary_color"`
	SupportEmail string `json:"support_email"`
	SupportURL   string `json:"support_url"`
}

func (s *Server) handleUpdateBranding(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req brandingRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	if req.PrimaryColor != "" && !isHexColor(req.PrimaryColor) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "primary_color must be a #rrggbb hex value")
		return
	}
	ptr := func(v string) *string {
		v = strings.TrimSpace(v)
		if v == "" {
			return nil
		}
		return &v
	}
	if err := s.deps.Store.UpsertBranding(ctx, p.OrgID, store.Branding{
		PanelName:    ptr(req.PanelName),
		LogoURL:      ptr(req.LogoURL),
		PrimaryColor: ptr(req.PrimaryColor),
		SupportEmail: ptr(req.SupportEmail),
		SupportURL:   ptr(req.SupportURL),
	}); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not save branding")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "branding.update", "organization", org.String(), audit.OutcomeSuccess, r, nil)

	b, _ := s.deps.Store.GetEffectiveBranding(ctx, p.OrgID)
	httpx.JSON(w, http.StatusOK, map[string]any{"branding": brandingView(b)})
}
