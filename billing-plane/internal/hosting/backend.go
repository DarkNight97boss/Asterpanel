// Package hosting is the provisioning seam between the billing product and a
// hosting control panel. The billing panel only ever speaks to this interface —
// it never knows whether AsterPanel, cPanel or Plesk is behind it. That is what
// makes the billing product a standalone WHMCS alternative rather than an
// AsterPanel add-on: hosting backends are pluggable modules.
package hosting

import (
	"context"
	"errors"
	"sort"
)

// ErrUnsupported is returned by a backend for an operation its panel cannot do.
var ErrUnsupported = errors.New("operation not supported by this hosting backend")

// Account is a provisioned hosting account as the billing panel sees it.
type Account struct {
	ID           string // the hosting panel's id for the account
	Email        string // owner email
	TempPassword string // one-time password handed to the customer (create only)
}

// CreateAccountRequest is what the billing panel knows when ordering a service.
type CreateAccountRequest struct {
	Name     string // company / account display name
	Email    string // owner email
	PlanCode string // the hosting package to provision (maps to a panel plan)
	Domain   string // primary domain (some panels, e.g. cPanel, require it)
}

// Backend is a hosting control panel a billing service can drive. Every method
// is the billing-side intent; each module translates it to its panel's API.
type Backend interface {
	// Name identifies the module ("asterpanel", "cpanel", "plesk", …).
	Name() string
	// TestConnection verifies the configured endpoint + credentials.
	TestConnection(ctx context.Context) error
	// CreateAccount provisions an account and returns its id + one-time password.
	CreateAccount(ctx context.Context, req CreateAccountRequest) (*Account, error)
	// SuspendAccount / UnsuspendAccount toggle service (used by dunning).
	SuspendAccount(ctx context.Context, id string) error
	UnsuspendAccount(ctx context.Context, id string) error
	// ChangePackage re-plans an account (upgrade / downgrade).
	ChangePackage(ctx context.Context, id, planCode string) error
}

// Registry holds the configured backends by name so a service/order can pick
// which panel to provision on — the multi-backend story (AsterPanel today,
// cPanel/Plesk tomorrow) is just more registrations here.
type Registry struct {
	backends map[string]Backend
}

func NewRegistry() *Registry { return &Registry{backends: map[string]Backend{}} }

func (r *Registry) Register(b Backend) { r.backends[b.Name()] = b }

// Get returns a backend by name, or false if it isn't registered.
func (r *Registry) Get(name string) (Backend, bool) {
	b, ok := r.backends[name]
	return b, ok
}

// Names lists the registered backend names, sorted for stable output.
func (r *Registry) Names() []string {
	out := make([]string, 0, len(r.backends))
	for n := range r.backends {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}
