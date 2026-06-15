package api

import (
	"context"
	"fmt"
)

// PaymentProvider settles an invoice with a payment backend. This is the seam a
// real processor plugs into: a Stripe/Adyen provider implements the same
// interface (creating a PaymentIntent, charging a saved method, etc.) and the
// invoice handlers stay unchanged. ManualPaymentProvider is the default —
// offline settlement (bank transfer / "mark as paid"), which records a manual
// reference and never contacts an external service.
type PaymentProvider interface {
	Charge(ctx context.Context, invoiceID, currency string, amountCents int) (reference string, err error)
}

type ManualPaymentProvider struct{}

func (ManualPaymentProvider) Charge(_ context.Context, invoiceID, _ string, _ int) (string, error) {
	return fmt.Sprintf("manual:%s", invoiceID), nil
}
