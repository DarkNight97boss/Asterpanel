// Package cloudflare is a thin client for the slice of the Cloudflare API the
// panel uses: verifying an API token, listing zones, managing a zone's DNS
// records, and purging the CDN cache. It talks to the real api.cloudflare.com
// (base URL is overridable for tests).
package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const DefaultBaseURL = "https://api.cloudflare.com/client/v4"

type Client struct {
	token string
	base  string
	http  *http.Client
}

// New returns a client for the real Cloudflare API.
func New(token string) *Client {
	return &Client{token: token, base: DefaultBaseURL, http: &http.Client{Timeout: 15 * time.Second}}
}

// NewWithBase overrides the base URL and HTTP client (used by tests).
func NewWithBase(token, base string, hc *http.Client) *Client {
	if hc == nil {
		hc = &http.Client{Timeout: 15 * time.Second}
	}
	return &Client{token: token, base: strings.TrimRight(base, "/"), http: hc}
}

type apiError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type apiResponse struct {
	Success bool            `json:"success"`
	Errors  []apiError      `json:"errors"`
	Result  json.RawMessage `json:"result"`
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("cloudflare: request failed: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))

	var ar apiResponse
	if err := json.Unmarshal(raw, &ar); err != nil {
		return fmt.Errorf("cloudflare: HTTP %d (unparseable response)", resp.StatusCode)
	}
	if !ar.Success {
		if len(ar.Errors) > 0 {
			return fmt.Errorf("cloudflare: %s (code %d)", ar.Errors[0].Message, ar.Errors[0].Code)
		}
		return fmt.Errorf("cloudflare: request unsuccessful (HTTP %d)", resp.StatusCode)
	}
	if out != nil && len(ar.Result) > 0 {
		return json.Unmarshal(ar.Result, out)
	}
	return nil
}

// TokenVerify is the result of GET /user/tokens/verify.
type TokenVerify struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

func (c *Client) VerifyToken(ctx context.Context) (*TokenVerify, error) {
	var tv TokenVerify
	if err := c.do(ctx, http.MethodGet, "/user/tokens/verify", nil, &tv); err != nil {
		return nil, err
	}
	return &tv, nil
}

type Zone struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

func (c *Client) ListZones(ctx context.Context) ([]Zone, error) {
	var zones []Zone
	if err := c.do(ctx, http.MethodGet, "/zones?per_page=50", nil, &zones); err != nil {
		return nil, err
	}
	return zones, nil
}

type DNSRecord struct {
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Proxied bool   `json:"proxied"`
	TTL     int    `json:"ttl,omitempty"`
}

func (c *Client) ListDNSRecords(ctx context.Context, zoneID string) ([]DNSRecord, error) {
	var recs []DNSRecord
	if err := c.do(ctx, http.MethodGet, "/zones/"+url.PathEscape(zoneID)+"/dns_records?per_page=100", nil, &recs); err != nil {
		return nil, err
	}
	return recs, nil
}

func (c *Client) CreateDNSRecord(ctx context.Context, zoneID string, rec DNSRecord) (*DNSRecord, error) {
	if rec.TTL == 0 {
		rec.TTL = 1 // 1 = "automatic" in Cloudflare
	}
	var out DNSRecord
	if err := c.do(ctx, http.MethodPost, "/zones/"+url.PathEscape(zoneID)+"/dns_records", rec, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateDNSRecord(ctx context.Context, zoneID, recordID string, rec DNSRecord) (*DNSRecord, error) {
	if rec.TTL == 0 {
		rec.TTL = 1 // 1 = "automatic" in Cloudflare
	}
	var out DNSRecord
	if err := c.do(ctx, http.MethodPut,
		"/zones/"+url.PathEscape(zoneID)+"/dns_records/"+url.PathEscape(recordID), rec, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteDNSRecord(ctx context.Context, zoneID, recordID string) error {
	return c.do(ctx, http.MethodDelete,
		"/zones/"+url.PathEscape(zoneID)+"/dns_records/"+url.PathEscape(recordID), nil, nil)
}

// PurgeCache purges everything cached for the zone (the classic CDN operation).
func (c *Client) PurgeCache(ctx context.Context, zoneID string) error {
	return c.do(ctx, http.MethodPost, "/zones/"+url.PathEscape(zoneID)+"/purge_cache",
		map[string]any{"purge_everything": true}, nil)
}
