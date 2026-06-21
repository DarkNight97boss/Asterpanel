// Package payments is the billing product's gateway-agnostic settlement seam.
// The billing core never talks to a specific processor; a Stripe/PayPal module
// implements Provider and plugs in. Manual (offline) settlement is the default,
// so invoicing works with no payment processor configured at all.
package payments

import (
	"context"
	"fmt"
)

type Provider interface {
	// Charge settles an invoice and returns a payment reference.
	Charge(ctx context.Context, invoiceID string, amountCents int) (reference string, err error)
}

// Manual records an offline payment (bank transfer / "mark as paid") without
// contacting any external service.
type Manual struct{}

func (Manual) Charge(_ context.Context, invoiceID string, _ int) (string, error) {
	return fmt.Sprintf("manual:%s", invoiceID), nil
}
