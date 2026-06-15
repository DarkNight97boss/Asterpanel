package authz

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// OPAClient queries an Open Policy Agent instance for policy decisions over the
// REST Data API. It fails closed: any transport/decode error yields a deny.
type OPAClient struct {
	baseURL string
	http    *http.Client
}

func NewOPAClient(baseURL string) *OPAClient {
	return &OPAClient{
		baseURL: baseURL,
		http:    &http.Client{Timeout: 3 * time.Second},
	}
}

// Decision is the result shape our policies return under data.asterpanel.authz.
type Decision struct {
	Allow   bool     `json:"allow"`
	Reasons []string `json:"reasons"`
}

type opaRequest struct {
	Input map[string]any `json:"input"`
}

type opaResponse struct {
	Result *Decision `json:"result"`
}

// Authorize evaluates data.asterpanel.authz with the given input document.
func (c *OPAClient) Authorize(ctx context.Context, input map[string]any) (Decision, error) {
	return c.Evaluate(ctx, "asterpanel/authz", input)
}

// Evaluate queries an arbitrary policy document (e.g. "asterpanel/jobs") whose
// result is shaped like a Decision ({allow, reasons}).
func (c *OPAClient) Evaluate(ctx context.Context, policyPath string, input map[string]any) (Decision, error) {
	body, err := json.Marshal(opaRequest{Input: input})
	if err != nil {
		return Decision{}, err
	}
	url := c.baseURL + "/v1/data/" + policyPath
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return Decision{}, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return Decision{Allow: false}, fmt.Errorf("opa: request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Decision{Allow: false}, fmt.Errorf("opa: status %d", resp.StatusCode)
	}

	var out opaResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return Decision{Allow: false}, fmt.Errorf("opa: decode: %w", err)
	}
	if out.Result == nil {
		// Undefined result => deny.
		return Decision{Allow: false, Reasons: []string{"policy returned no decision"}}, nil
	}
	return *out.Result, nil
}
