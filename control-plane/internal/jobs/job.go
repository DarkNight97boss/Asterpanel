// Package jobs defines the signed job envelope dispatched from the control
// plane to node agents, plus its canonical encoding, signer and verifier.
package jobs

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/canonical"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
)

// Type is the discriminator that selects an executor on the agent.
type Type string

const (
	TypeWebsiteCreate    Type = "website.create"
	TypeWebsiteDelete    Type = "website.delete"
	TypeAppDeploy        Type = "app.deploy"
	TypeAppRollback      Type = "app.rollback"
	TypeAppStart         Type = "app.start"
	TypeAppStop          Type = "app.stop"
	TypeProxyApply       Type = "proxy.apply"
	TypeCertIssue        Type = "cert.issue"
	TypeDNSApply         Type = "dns.apply"
	TypeBackupCreate     Type = "backup.create"
	TypeBackupRestore    Type = "backup.restore"
	TypeDatabaseCreate   Type = "database.create"
	TypeDatabaseDelete   Type = "database.delete"
	TypeDatabaseUser     Type = "database.user.create"
	TypeMailboxCreate    Type = "mail.mailbox.create"
	TypeMailServerEnsure Type = "mail.server.ensure"
	TypeCronApply        Type = "cron.apply"
	TypeFTPAccountCreate Type = "ftp.account.create"
	TypeCertInstall      Type = "cert.install"
	TypeFirewallApply    Type = "firewall.apply"
	TypeHealthCheck      Type = "health.check"
)

// Job is the signed instruction envelope. Field order is irrelevant — the
// canonical encoder sorts keys before signing.
type Job struct {
	ID        uuid.UUID       `json:"id"`
	Type      Type            `json:"type"`
	NodeID    uuid.UUID       `json:"node_id"`
	TenantID  uuid.UUID       `json:"tenant_id"`
	Nonce     string          `json:"nonce"`     // base64url(32 bytes), anti-replay
	IssuedAt  time.Time       `json:"issued_at"` // UTC
	ExpiresAt time.Time       `json:"expires_at"`
	Payload   json.RawMessage `json:"payload"` // type-specific, schema-validated by the agent
}

// New builds a job with a fresh id + nonce and a TTL window. clock is injected
// for testability; pass time.Now in production.
func New(typ Type, nodeID, tenantID uuid.UUID, payload any, ttl time.Duration, now time.Time) (*Job, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	nonce, err := crypto.RandomTokenURL(32)
	if err != nil {
		return nil, err
	}
	return &Job{
		ID:        uuid.New(),
		Type:      typ,
		NodeID:    nodeID,
		TenantID:  tenantID,
		Nonce:     nonce,
		IssuedAt:  now.UTC(),
		ExpiresAt: now.UTC().Add(ttl),
		Payload:   raw,
	}, nil
}

// CanonicalBytes returns the deterministic encoding that is signed and sent.
func (j *Job) CanonicalBytes() ([]byte, error) {
	return canonical.Marshal(j)
}

// Expired reports whether the job's TTL has elapsed at time now.
func (j *Job) Expired(now time.Time) bool { return now.After(j.ExpiresAt) }
