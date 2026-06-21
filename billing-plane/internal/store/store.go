// Package store is the billing product's own data model and persistence seam.
// It is deliberately independent of the hosting control plane: a Service merely
// records WHICH hosting account a billing service is bound to (provisioned via
// the hosting.Backend module), never the panel's internal rows.
package store

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"
)

var ErrNotFound = errors.New("not found")

// Client is the billing customer (the WHMCS "client").
type Client struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Email     string    `json:"email"`
	Status    string    `json:"status"` // active, suspended, closed
	CreatedAt time.Time `json:"created_at"`
}

// Service is a sold product instance bound to a provisioned hosting account.
type Service struct {
	ID               string    `json:"id"`
	ClientID         string    `json:"client_id"`
	Product          string    `json:"product"`
	PlanCode         string    `json:"plan_code"`
	Backend          string    `json:"backend"`            // which hosting module provisioned it
	HostingAccountID string    `json:"hosting_account_id"` // the panel's id for the account
	Status           string    `json:"status"`             // pending, active, suspended, terminated
	CreatedAt        time.Time `json:"created_at"`
}

// Store is the persistence seam. An in-memory implementation backs the MVP; a
// Postgres implementation drops in behind the same interface later.
type Store interface {
	CreateClient(name, email string) (Client, error)
	ListClients() []Client
	GetClient(id string) (Client, error)

	CreateService(s Service) (Service, error)
	ListServices() []Service
	GetService(id string) (Service, error)
	SetServiceStatus(id, status string) (Service, error)
}

// NewID returns a prefixed random identifier (no external uuid dependency).
func NewID(prefix string) string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}
