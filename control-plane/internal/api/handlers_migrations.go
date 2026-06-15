package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/migrate"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

func migrationView(m store.AccountMigration, full bool) map[string]any {
	v := map[string]any{
		"id":              m.ID,
		"source_type":     m.SourceType,
		"source_label":    m.SourceLabel,
		"status":          m.Status,
		"domains_count":   m.DomainsCount,
		"databases_count": m.DatabasesCount,
		"mailboxes_count": m.MailboxesCount,
		"created_at":      m.CreatedAt,
		"completed_at":    m.CompletedAt,
	}
	if full {
		v["plan"] = json.RawMessage(m.Plan)
		v["log"] = json.RawMessage(m.Log)
	}
	return v
}

func (s *Server) handleListMigrations(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	migs, err := s.deps.Store.ListMigrations(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list migrations")
		return
	}
	views := make([]map[string]any, 0, len(migs))
	for _, m := range migs {
		views = append(views, migrationView(m, false))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"migrations": views})
}

func (s *Server) handleGetMigration(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "migrationID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid migration id")
		return
	}
	m, err := s.deps.Store.GetMigration(ctx, p.OrgID, id)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "migration not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"migration": migrationView(*m, true)})
}

type createMigrationRequest struct {
	SourceType  string          `json:"source_type"`
	SourceLabel string          `json:"source_label"`
	Manifest    json.RawMessage `json:"manifest"`
}

// handleCreateMigration parses a source account manifest into a migration plan
// and stores it (status "planned"). The import is a separate, explicit step.
func (s *Server) handleCreateMigration(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createMigrationRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	sourceType := req.SourceType
	if sourceType == "" {
		sourceType = "cpanel"
	}
	if sourceType != "cpanel" && sourceType != "plesk" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "source_type must be cpanel or plesk")
		return
	}
	plan, err := migrate.ParseCpanel(req.Manifest)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_manifest", err.Error())
		return
	}
	planJSON, _ := json.Marshal(plan)
	d, db, mb := plan.Counts()
	mig, err := s.deps.Store.CreateMigration(ctx, store.CreateMigrationParams{
		OrgID: p.OrgID, SourceType: sourceType, SourceLabel: req.SourceLabel, Plan: planJSON,
		DomainsCount: d, DatabasesCount: db, MailboxesCount: mb,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not save migration")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "migration.plan", "migration", mig.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"domains": d, "databases": db, "mailboxes": mb})
	httpx.JSON(w, http.StatusCreated, map[string]any{"migration": migrationView(*mig, true)})
}

// handleRunImport executes a planned migration: domains + their DNS are created
// for real (reusing the domain/DNS vertical); databases and mailboxes are logged
// as manual steps (their data migration needs source credentials).
func (s *Server) handleRunImport(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "migrationID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid migration id")
		return
	}
	mig, err := s.deps.Store.GetMigration(ctx, p.OrgID, id)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "migration not found")
		return
	}
	if mig.Status == "completed" {
		httpx.JSON(w, http.StatusOK, map[string]any{"migration": migrationView(*mig, true)})
		return
	}
	var plan migrate.Plan
	if uerr := json.Unmarshal(mig.Plan, &plan); uerr != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "migration plan is corrupt")
		return
	}

	log := make([]map[string]any, 0)
	for _, d := range plan.Domains {
		_, zoneID, derr := s.deps.Store.CreateDomainWithZone(ctx, p.OrgID, d.FQDN)
		if derr != nil {
			log = append(log, map[string]any{"resource": "domain", "item": d.FQDN, "result": "skipped", "detail": "already exists"})
			continue
		}
		records := 0
		for _, rec := range d.Records {
			if _, rerr := s.deps.Store.CreateDNSRecord(ctx, store.CreateDNSRecordParams{
				OrgID: p.OrgID, ZoneID: zoneID, Name: rec.Name, Type: rec.Type,
				Content: rec.Content, TTL: rec.TTL, Priority: rec.Priority,
			}); rerr == nil {
				records++
			}
		}
		s.applyZone(ctx, p, zoneID)
		log = append(log, map[string]any{"resource": "domain", "item": d.FQDN, "result": "imported", "records": records})
	}
	for _, dbName := range plan.Databases {
		log = append(log, map[string]any{"resource": "database", "item": dbName, "result": "manual",
			"detail": "recreate + import the dump with source credentials"})
	}
	for _, mbox := range plan.Mailboxes {
		log = append(log, map[string]any{"resource": "mailbox", "item": mbox, "result": "manual",
			"detail": "create mailbox + migrate mail via IMAP sync"})
	}

	logJSON, _ := json.Marshal(log)
	if uerr := s.deps.Store.UpdateMigration(ctx, p.OrgID, id, "completed", logJSON); uerr != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not record import result")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "migration.import", "migration", id.String(), audit.OutcomeSuccess, r,
		map[string]any{"domains": len(plan.Domains)})

	updated, _ := s.deps.Store.GetMigration(ctx, p.OrgID, id)
	if updated == nil {
		updated = mig
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"migration": migrationView(*updated, true)})
}
