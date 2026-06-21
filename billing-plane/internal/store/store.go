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

// Product is a sellable item in the catalog: a hosting package the billing
// panel offers, mapped to a plan_code the hosting backend understands.
type Product struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	PlanCode   string    `json:"plan_code"`   // the hosting backend's package code
	PriceCents int       `json:"price_cents"` // recurring price
	Cycle      string    `json:"cycle"`       // monthly, yearly
	CreatedAt  time.Time `json:"created_at"`
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

type InvoiceLine struct {
	Description string `json:"description"`
	AmountCents int    `json:"amount_cents"`
}

// Invoice is a bill the billing panel owns (not the hosting control plane).
type Invoice struct {
	ID         string        `json:"id"`
	ClientID   string        `json:"client_id"`
	Number     string        `json:"number"`
	Status     string        `json:"status"` // open, paid, void
	TotalCents int           `json:"total_cents"`
	Lines      []InvoiceLine `json:"lines"`
	IssuedAt   time.Time     `json:"issued_at"`
	DueAt      time.Time     `json:"due_at"`
	PaidAt     *time.Time    `json:"paid_at"`
}

// Store is the persistence seam. An in-memory implementation backs the MVP; a
// Postgres implementation drops in behind the same interface later.
type Store interface {
	CreateClient(name, email string) (Client, error)
	ListClients() []Client
	GetClient(id string) (Client, error)

	CreateProduct(name, planCode string, priceCents int, cycle string) (Product, error)
	ListProducts() []Product
	GetProduct(id string) (Product, error)
	DeleteProduct(id string) error

	CreateService(s Service) (Service, error)
	ListServices() []Service
	GetService(id string) (Service, error)
	SetServiceStatus(id, status string) (Service, error)

	CreateInvoice(clientID string, lines []InvoiceLine, dueDays int) (Invoice, error)
	ListInvoices() []Invoice
	GetInvoice(id string) (Invoice, error)
	SetInvoiceStatus(id, status string) (Invoice, error)
}

// NewID returns a prefixed random identifier (no external uuid dependency).
func NewID(prefix string) string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}
