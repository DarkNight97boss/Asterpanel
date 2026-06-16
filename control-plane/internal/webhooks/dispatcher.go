// Package webhooks delivers outbound HMAC-signed events to customer URLs.
//
// Each payload is signed with HMAC-SHA256 over the raw body using the webhook's
// secret; recipients verify with `X-AsterPanel-Signature: sha256=<hex>`. A
// timestamp header guards against replay. Delivery is best-effort with a short
// timeout: a failure logs and stores the status but never fails the trigger.
package webhooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

// Sign returns the lowercase hex HMAC-SHA256 of body under secret.
func Sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// Verify reports whether a signature header value matches body+secret. Accepts
// either the bare hex or the `sha256=<hex>` prefixed form.
func Verify(secret string, body []byte, header string) bool {
	const prefix = "sha256="
	sigHex := header
	if len(sigHex) > len(prefix) && sigHex[:len(prefix)] == prefix {
		sigHex = sigHex[len(prefix):]
	}
	got, err := hex.DecodeString(sigHex)
	if err != nil {
		return false
	}
	want, _ := hex.DecodeString(Sign(secret, body))
	return hmac.Equal(got, want)
}

type Dispatcher struct {
	store  *store.Store
	log    *slog.Logger
	client *http.Client
}

func NewDispatcher(st *store.Store, log *slog.Logger) *Dispatcher {
	return &Dispatcher{
		store:  st,
		log:    log,
		client: &http.Client{Timeout: 5 * time.Second},
	}
}

type Envelope struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	OrgID string `json:"organization_id"`
	Data  any    `json:"data"`
	Sent  string `json:"sent_at"`
}

// Fire delivers an event to every active webhook the org has subscribed to it
// (empty events list = subscribe-all). Runs in-line; callers can `go` it.
func (d *Dispatcher) Fire(ctx context.Context, orgID uuid.UUID, event string, data any) {
	subs, err := d.store.WebhooksForEvent(ctx, orgID, event)
	if err != nil {
		d.log.Warn("webhooks: lookup failed", "error", err)
		return
	}
	if len(subs) == 0 {
		return
	}
	now := time.Now().UTC()
	body, err := json.Marshal(Envelope{
		ID: uuid.New().String(), Type: event, OrgID: orgID.String(), Data: data, Sent: now.Format(time.RFC3339Nano),
	})
	if err != nil {
		return
	}
	for _, h := range subs {
		d.deliver(ctx, h, body, now)
	}
}

func (d *Dispatcher) deliver(ctx context.Context, h store.Webhook, body []byte, now time.Time) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.URL, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "AsterPanel-Webhook/1")
	req.Header.Set("X-AsterPanel-Timestamp", now.Format(time.RFC3339Nano))
	req.Header.Set("X-AsterPanel-Signature", "sha256="+Sign(h.Secret, body))

	resp, err := d.client.Do(req)
	status := 0
	if err == nil {
		status = resp.StatusCode
		resp.Body.Close()
	} else {
		d.log.Warn("webhook delivery failed", "id", h.ID, "url", h.URL, "error", err)
	}
	_ = d.store.UpdateWebhookDelivery(ctx, h.ID, status)
}
