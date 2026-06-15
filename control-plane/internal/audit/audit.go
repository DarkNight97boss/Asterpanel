// Package audit defines the append-only, hash-chained audit log entry and the
// chaining function. Each entry's hash = SHA-256(prev_hash || canonical(entry)),
// giving a tamper-evident chain. The store appends entries under a per-org
// advisory lock so each organization gets a single, well-ordered chain.
package audit

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"time"

	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/canonical"
)

// Actor types.
const (
	ActorUser     = "user"
	ActorSystem   = "system"
	ActorAgent    = "agent"
	ActorAPIToken = "api_token"
)

// Outcomes.
const (
	OutcomeSuccess = "success"
	OutcomeFailure = "failure"
	OutcomeDenied  = "denied"
)

// Entry is one audit record. Pointer fields are nullable columns.
type Entry struct {
	OrganizationID *uuid.UUID     `json:"organization_id,omitempty"`
	ActorUserID    *uuid.UUID     `json:"actor_user_id,omitempty"`
	ActorType      string         `json:"actor_type"`
	ActorTokenID   *uuid.UUID     `json:"actor_token_id,omitempty"`
	SessionID      *uuid.UUID     `json:"session_id,omitempty"`
	Action         string         `json:"action"`
	ResourceType   string         `json:"resource_type,omitempty"`
	ResourceID     string         `json:"resource_id,omitempty"`
	Outcome        string         `json:"outcome"`
	IP             string         `json:"ip,omitempty"`
	UserAgent      string         `json:"user_agent,omitempty"`
	RequestID      string         `json:"request_id,omitempty"`
	Metadata       map[string]any `json:"metadata,omitempty"`
	CreatedAt      time.Time      `json:"created_at"`
}

// ChainHash returns SHA-256(prev || canonical(entry)). prev may be nil for the
// first entry in an organization's chain.
func ChainHash(prev []byte, e Entry) ([]byte, error) {
	body, err := canonical.Marshal(e)
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	h.Write(prev)
	h.Write(body)
	return h.Sum(nil), nil
}

// Row is a persisted entry plus its stored chain hashes, used for verification.
type Row struct {
	Entry    Entry
	PrevHash []byte
	Hash     []byte
}

// VerifyChain recomputes the chain over rows in insertion order and reports the
// index of the first inconsistency, or -1 if the chain is intact.
func VerifyChain(rows []Row) int {
	var prev []byte
	for i, r := range rows {
		if subtle.ConstantTimeCompare(prev, r.PrevHash) != 1 && !(prev == nil && r.PrevHash == nil) {
			return i
		}
		want, err := ChainHash(r.PrevHash, r.Entry)
		if err != nil || subtle.ConstantTimeCompare(want, r.Hash) != 1 {
			return i
		}
		prev = r.Hash
	}
	return -1
}

// Sink appends audit entries. Implemented by the store (with advisory locking).
type Sink interface {
	Append(ctx context.Context, e Entry) error
}
