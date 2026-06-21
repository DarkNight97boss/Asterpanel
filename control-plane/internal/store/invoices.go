package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Plan is the org's full billing plan (rate + cadence), used to bill invoices.
type Plan struct {
	Code       string
	Name       string
	Currency   string
	Interval   string
	PriceCents int
}

// GetOrgPlan returns the org's plan, or nil when it has none.
func (s *Store) GetOrgPlan(ctx context.Context, orgID uuid.UUID) (*Plan, error) {
	var pl Plan
	err := s.pool.QueryRow(ctx, `
		SELECT bp.code, bp.name, bp.price_cents, bp.currency, bp.interval
		FROM organizations o JOIN billing_plans bp ON bp.id = o.billing_plan_id
		WHERE o.id = $1`, orgID).
		Scan(&pl.Code, &pl.Name, &pl.PriceCents, &pl.Currency, &pl.Interval)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &pl, nil
}

type InvoiceLine struct {
	Description string
	Quantity    int
	UnitCents   int
	AmountCents int
}

type Invoice struct {
	ID            uuid.UUID
	OrgID         uuid.UUID
	Number        string
	Status        string
	Currency      string
	PeriodStart   time.Time
	PeriodEnd     time.Time
	SubtotalCents int
	TotalCents    int
	IssuedAt      time.Time
	DueAt         *time.Time
	PaidAt        *time.Time
	Lines         []InvoiceLine // populated by GetInvoice
}

const invoiceCols = `id, number, status, currency, period_start, period_end,
	subtotal_cents, total_cents, issued_at, due_at, paid_at`

func scanInvoice(row rowScanner, orgID uuid.UUID) (*Invoice, error) {
	var inv Invoice
	inv.OrgID = orgID
	if err := row.Scan(&inv.ID, &inv.Number, &inv.Status, &inv.Currency, &inv.PeriodStart,
		&inv.PeriodEnd, &inv.SubtotalCents, &inv.TotalCents, &inv.IssuedAt, &inv.DueAt, &inv.PaidAt); err != nil {
		return nil, err
	}
	return &inv, nil
}

// HasInvoiceForPeriod reports whether the org already has an invoice covering
// the given billing period — the idempotency guard for recurring billing so a
// re-run never double-bills the same month.
func (s *Store) HasInvoiceForPeriod(ctx context.Context, orgID uuid.UUID, periodStart time.Time) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM invoices WHERE organization_id = $1 AND period_start = $2::date)`,
		orgID, periodStart).Scan(&ok)
	return ok, err
}

// CountOrgInvoices is used to number new invoices (INV-YYYY-NNNN).
func (s *Store) CountOrgInvoices(ctx context.Context, orgID uuid.UUID) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM invoices WHERE organization_id = $1`, orgID).Scan(&n)
	return n, err
}

// CreateInvoice inserts an invoice and its line items in one transaction; the
// total is the sum of the line amounts.
func (s *Store) CreateInvoice(ctx context.Context, orgID uuid.UUID, number, currency string, periodStart, periodEnd time.Time, dueAt *time.Time, lines []InvoiceLine) (*Invoice, error) {
	subtotal := 0
	for _, l := range lines {
		subtotal += l.AmountCents
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	inv, err := scanInvoice(tx.QueryRow(ctx, `
		INSERT INTO invoices (organization_id, number, currency, period_start, period_end, subtotal_cents, total_cents, due_at)
		VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
		RETURNING `+invoiceCols, orgID, number, currency, periodStart, periodEnd, subtotal, dueAt), orgID)
	if err != nil {
		return nil, err
	}
	for i, l := range lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_cents, amount_cents, sort)
			VALUES ($1, $2, $3, $4, $5, $6)`, inv.ID, l.Description, l.Quantity, l.UnitCents, l.AmountCents, i); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	inv.Lines = lines
	return inv, nil
}

func (s *Store) ListInvoices(ctx context.Context, orgID uuid.UUID) ([]Invoice, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+invoiceCols+` FROM invoices WHERE organization_id = $1 ORDER BY issued_at DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Invoice
	for rows.Next() {
		inv, err := scanInvoice(rows, orgID)
		if err != nil {
			return nil, err
		}
		out = append(out, *inv)
	}
	return out, rows.Err()
}

// GetInvoice returns an invoice with its line items, scoped to the org.
func (s *Store) GetInvoice(ctx context.Context, orgID, id uuid.UUID) (*Invoice, error) {
	inv, err := scanInvoice(s.pool.QueryRow(ctx,
		`SELECT `+invoiceCols+` FROM invoices WHERE id = $1 AND organization_id = $2`, id, orgID), orgID)
	if err != nil {
		return nil, norows(err)
	}
	rows, err := s.pool.Query(ctx,
		`SELECT description, quantity, unit_cents, amount_cents FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var l InvoiceLine
		if err := rows.Scan(&l.Description, &l.Quantity, &l.UnitCents, &l.AmountCents); err != nil {
			return nil, err
		}
		inv.Lines = append(inv.Lines, l)
	}
	return inv, rows.Err()
}

// SetInvoiceStatus transitions an invoice (e.g. to paid/void), scoped to the org.
func (s *Store) SetInvoiceStatus(ctx context.Context, orgID, id uuid.UUID, status string, paidAt *time.Time) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE invoices SET status = $3, paid_at = $4 WHERE id = $1 AND organization_id = $2`,
		id, orgID, status, paidAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
