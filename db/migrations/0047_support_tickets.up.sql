-- 0047_support_tickets.up.sql — a support desk: tickets with threaded messages,
-- scoped per organization (a customer's tickets live in its own org; staff reply
-- on the same thread).
BEGIN;

CREATE TABLE support_tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject         text NOT NULL,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'pending', 'closed')),
  priority        text NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('low', 'normal', 'high')),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_support_tickets_org ON support_tickets (organization_id, updated_at DESC);

CREATE TABLE support_ticket_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  body            text NOT NULL,
  staff           boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_support_messages_ticket ON support_ticket_messages (ticket_id, created_at);

INSERT INTO permissions (key, description, category) VALUES
  ('support.read',   'View support tickets',          'support'),
  ('support.manage', 'Open, reply to and close tickets', 'support')
ON CONFLICT (key) DO NOTHING;

-- Everyone can read; owner/admin/developer/member can open + reply (viewers read-only).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name IN ('owner','admin','developer','member','viewer')
  AND p.key = 'support.read'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name IN ('owner','admin','developer','member')
  AND p.key = 'support.manage'
ON CONFLICT DO NOTHING;

COMMIT;
