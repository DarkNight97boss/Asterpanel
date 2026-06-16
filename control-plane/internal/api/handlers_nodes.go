package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/licensing"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

func nodeView(n store.ServerNode) map[string]any {
	labels := json.RawMessage(n.Labels)
	if len(labels) == 0 {
		labels = json.RawMessage("{}")
	}
	return map[string]any{
		"id":                n.ID,
		"name":              n.Name,
		"hostname":          n.Hostname,
		"region":            n.Region,
		"ip_address":        n.IPAddress,
		"status":            n.Status,
		"agent_version":     n.AgentVersion,
		"labels":            labels,
		"last_heartbeat_at": n.LastHeartbeatAt,
		"enrolled_at":       n.EnrolledAt,
		"created_at":        n.CreatedAt,
	}
}

func (s *Server) handleListNodes(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	nodes, err := s.deps.Store.ListNodes(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list nodes")
		return
	}
	views := make([]map[string]any, 0, len(nodes))
	for _, n := range nodes {
		views = append(views, nodeView(n))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"nodes": views})
}

type createNodeRequest struct {
	Name     string `json:"name"`
	Hostname string `json:"hostname"`
	Region   string `json:"region"`
}

func (s *Server) handleCreateNode(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createNodeRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Hostname) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "name and hostname are required")
		return
	}
	// Community edition (no multi_node feature) is capped at a single node.
	if max := s.licenseMgr().MaxNodes(); max > 0 {
		if existing, _ := s.deps.Store.ListNodes(ctx, p.OrgID); len(existing) >= max {
			httpx.ErrorWithDetails(w, http.StatusPaymentRequired, "license_required",
				"this edition is limited to one node — a Pro license unlocks multi-node",
				map[string]any{"feature": licensing.FeatureMultiNode, "max_nodes": max})
			return
		}
	}
	var region *string
	if strings.TrimSpace(req.Region) != "" {
		region = &req.Region
	}
	node, err := s.deps.Store.CreateNode(ctx, p.OrgID, req.Name, req.Hostname, region)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create node (name may already exist)")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "node.create", "server_node", node.ID.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusCreated, map[string]any{"node": nodeView(*node)})
}

// handleCreateEnrollment issues a single-use, short-TTL bootstrap token an agent
// uses once to obtain its mTLS certificate. The token is shown exactly once.
func (s *Server) handleCreateEnrollment(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	nodeID, err := uuid.Parse(chi.URLParam(r, "nodeID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid node id")
		return
	}
	if _, err := s.deps.Store.GetNode(ctx, p.OrgID, nodeID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "node not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "lookup failed")
		return
	}

	token, _ := crypto.RandomTokenURL(32)
	expiresAt := time.Now().Add(15 * time.Minute)
	regID, err := s.deps.Store.CreateAgentRegistration(ctx, nodeID, p.OrgID, crypto.SHA256([]byte(token)),
		uuid.NullUUID{UUID: p.UserID, Valid: true}, expiresAt)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create enrollment")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "node.enroll", "server_node", nodeID.String(), audit.OutcomeSuccess, r,
		map[string]any{"registration_id": regID.String()})

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"registration_id":  regID,
		"node_id":          nodeID,
		"enrollment_token": token, // shown once; the agent presents it during bootstrap
		"expires_at":       expiresAt,
		"install_hint":     "curl -fsSL <panel>/install-node-agent.sh | AGENT_ENROLLMENT_TOKEN=<token> bash",
	})
}
