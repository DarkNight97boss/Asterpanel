package hosting

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// AsterPanel drives an AsterPanel hosting control plane over its token-authed
// REST API. It is one Backend implementation; cPanel/Plesk modules implement the
// same interface against their own APIs.
type AsterPanel struct {
	baseURL string
	token   string
	http    *http.Client
}

// NewAsterPanel builds the module. baseURL is the control plane root
// (e.g. https://panel.example.com); token is an API token with reseller scope.
func NewAsterPanel(baseURL, token string) *AsterPanel {
	return &AsterPanel{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 20 * time.Second},
	}
}

func (a *AsterPanel) Name() string { return "asterpanel" }

func (a *AsterPanel) TestConnection(ctx context.Context) error {
	return a.do(ctx, http.MethodGet, "/api/v1/reseller/accounts", nil, nil)
}

func (a *AsterPanel) CreateAccount(ctx context.Context, req CreateAccountRequest) (*Account, error) {
	body := map[string]any{"name": req.Name, "admin_email": req.Email}
	if req.PlanCode != "" {
		body["plan_code"] = req.PlanCode
	}
	var resp struct {
		Account struct {
			ID string `json:"id"`
		} `json:"account"`
		OwnerEmail   string `json:"owner_email"`
		TempPassword string `json:"temp_password"`
	}
	if err := a.do(ctx, http.MethodPost, "/api/v1/reseller/accounts", body, &resp); err != nil {
		return nil, err
	}
	return &Account{ID: resp.Account.ID, Email: resp.OwnerEmail, TempPassword: resp.TempPassword}, nil
}

func (a *AsterPanel) SuspendAccount(ctx context.Context, id string) error {
	return a.setStatus(ctx, id, "suspended")
}

func (a *AsterPanel) UnsuspendAccount(ctx context.Context, id string) error {
	return a.setStatus(ctx, id, "active")
}

func (a *AsterPanel) setStatus(ctx context.Context, id, status string) error {
	return a.do(ctx, http.MethodPost,
		"/api/v1/reseller/accounts/"+id+"/status", map[string]any{"status": status}, nil)
}

func (a *AsterPanel) ChangePackage(ctx context.Context, id, planCode string) error {
	return a.do(ctx, http.MethodPost,
		"/api/v1/reseller/accounts/"+id+"/plan", map[string]any{"plan_code": planCode}, nil)
}

// do performs an authenticated request and, when out != nil, decodes the JSON
// body into it. A non-2xx status is turned into an error carrying the panel's
// message when present.
func (a *AsterPanel) do(ctx context.Context, method, path string, body any, out any) error {
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(raw)
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, a.baseURL+path, rdr)
	if err != nil {
		return err
	}
	httpReq.Header.Set("Authorization", "Bearer "+a.token)
	httpReq.Header.Set("Accept", "application/json")
	if body != nil {
		httpReq.Header.Set("Content-Type", "application/json")
	}
	res, err := a.http.Do(httpReq)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("asterpanel %s %s: %s", method, path, apiErrorMessage(payload, res.StatusCode))
	}
	if out != nil {
		return json.Unmarshal(payload, out)
	}
	return nil
}

// apiErrorMessage extracts {"error":{"message":...}} or {"error":"..."} from a
// control-plane error body, falling back to the status code.
func apiErrorMessage(payload []byte, status int) string {
	var withObj struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(payload, &withObj) == nil && withObj.Error.Message != "" {
		return withObj.Error.Message
	}
	var withStr struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(payload, &withStr) == nil && withStr.Error != "" {
		return withStr.Error
	}
	return fmt.Sprintf("status %d", status)
}
