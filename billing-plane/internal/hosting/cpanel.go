package hosting

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// CPanel drives a cPanel/WHM server over WHM API 1. It is a second Backend
// implementation alongside AsterPanel — the proof that the billing product is
// hosting-agnostic: the same billing intents (create/suspend/unsuspend/change
// package) map onto WHM's createacct/suspendacct/unsuspendacct/changepackage.
type CPanel struct {
	baseURL string // https://host:2087
	user    string // WHM user (e.g. root or a reseller)
	token   string // WHM API token
	http    *http.Client
}

// NewCPanel builds the module. baseURL is the WHM endpoint (…:2087); user/token
// authenticate as `Authorization: whm user:token`.
func NewCPanel(baseURL, user, token string) *CPanel {
	return &CPanel{
		baseURL: strings.TrimRight(baseURL, "/"),
		user:    user,
		token:   token,
		http:    &http.Client{Timeout: 20 * time.Second},
	}
}

func (c *CPanel) Name() string { return "cpanel" }

func (c *CPanel) TestConnection(ctx context.Context) error {
	return c.call(ctx, "version", nil)
}

func (c *CPanel) CreateAccount(ctx context.Context, req CreateAccountRequest) (*Account, error) {
	if strings.TrimSpace(req.Domain) == "" {
		return nil, fmt.Errorf("cpanel: a domain is required to create an account")
	}
	user := cpanelUsername(req.Email)
	if err := c.call(ctx, "createacct", url.Values{
		"username": {user}, "domain": {req.Domain}, "plan": {req.PlanCode}, "contactemail": {req.Email},
	}); err != nil {
		return nil, err
	}
	return &Account{ID: user, Email: req.Email}, nil
}

func (c *CPanel) SuspendAccount(ctx context.Context, id string) error {
	return c.call(ctx, "suspendacct", url.Values{"user": {id}})
}

func (c *CPanel) UnsuspendAccount(ctx context.Context, id string) error {
	return c.call(ctx, "unsuspendacct", url.Values{"user": {id}})
}

func (c *CPanel) ChangePackage(ctx context.Context, id, planCode string) error {
	return c.call(ctx, "changepackage", url.Values{"user": {id}, "pkg": {planCode}})
}

// call invokes a WHM API 1 function and turns a non-success metadata.result into
// an error carrying WHM's reason.
func (c *CPanel) call(ctx context.Context, fn string, params url.Values) error {
	if params == nil {
		params = url.Values{}
	}
	params.Set("api.version", "1")
	u := fmt.Sprintf("%s/json-api/%s?%s", c.baseURL, fn, params.Encode())
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	httpReq.Header.Set("Authorization", "whm "+c.user+":"+c.token)
	res, err := c.http.Do(httpReq)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("cpanel %s: HTTP %d", fn, res.StatusCode)
	}
	var out struct {
		Metadata struct {
			Result int    `json:"result"`
			Reason string `json:"reason"`
		} `json:"metadata"`
	}
	if json.Unmarshal(payload, &out) == nil && out.Metadata.Result == 0 {
		reason := out.Metadata.Reason
		if reason == "" {
			reason = "rejected"
		}
		return fmt.Errorf("cpanel %s: %s", fn, reason)
	}
	return nil
}

// cpanelUsername derives a valid cPanel username (lowercase alphanumeric, starts
// with a letter, max 16) from an email local-part.
func cpanelUsername(email string) string {
	local := email
	if i := strings.IndexByte(email, '@'); i >= 0 {
		local = email[:i]
	}
	var b strings.Builder
	for _, r := range strings.ToLower(local) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
		if b.Len() >= 16 {
			break
		}
	}
	u := b.String()
	if u == "" || !(u[0] >= 'a' && u[0] <= 'z') {
		u = "u" + u
		if len(u) > 16 {
			u = u[:16]
		}
	}
	return u
}
