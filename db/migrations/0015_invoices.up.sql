-- 0015_invoices.up.sql — invoices + line items, billing.manage permission.
BEGIN;

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number          text NOT NULL,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('draft','open','paid','void')),
  currency        text NOT NULL DEFAULT 'EUR',
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  subtotal_cents  int  NOT NULL DEFAULT 0,
  total_cents     int  NOT NULL DEFAULT 0,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  due_at          timestamptz,
  paid_at         timestamptz
);
CREATE UNIQUE INDEX uq_invoice_org_number ON invoices (organization_id, number);
CREATE INDEX idx_invoices_org ON invoices (organization_id, issued_at DESC);

CREATE TABLE invoice_line_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description  text NOT NULL,
  quantity     int  NOT NULL DEFAULT 1,
  unit_cents   int  NOT NULL DEFAULT 0,
  amount_cents int  NOT NULL DEFAULT 0,
  sort         int  NOT NULL DEFAULT 0
);
CREATE INDEX idx_line_items_invoice ON invoice_line_items (invoice_id, sort);

INSERT INTO permissions (key, description, category) VALUES
  ('billing.manage', 'Generate and settle invoices', 'billing')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name IN ('owner','admin')
  AND p.key = 'billing.manage'
ON CONFLICT DO NOTHING;

COMMIT;
