// Package agentcomm dispatches signed jobs to node agents over mTLS. The HTTP
// body is the exact canonical job bytes that were signed; the signature travels
// in a header so the agent can verify the bytes verbatim.
package agentcomm

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net/http"
	"os"
	"time"
)

type Dispatcher struct {
	client     *http.Client
	keyID      string
	configured bool
}

// NewDispatcher builds an mTLS HTTP client from the control-plane client cert and
// the project CA. Missing/invalid cert material does not fail startup: the
// dispatcher is marked unconfigured and Dispatch returns ErrNotConfigured, so the
// API can still serve non-dispatch endpoints in a fresh dev environment.
func NewDispatcher(caCertPath, clientCertPath, clientKeyPath, keyID string) *Dispatcher {
	d := &Dispatcher{keyID: keyID}

	cert, err := tls.LoadX509KeyPair(clientCertPath, clientKeyPath)
	if err != nil {
		return d
	}
	caPEM, err := os.ReadFile(caCertPath)
	if err != nil {
		return d
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return d
	}

	d.client = &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				Certificates: []tls.Certificate{cert},
				RootCAs:      pool,
				MinVersion:   tls.VersionTLS13,
			},
		},
	}
	d.configured = true
	return d
}

func (d *Dispatcher) Configured() bool { return d.configured }

var ErrNotConfigured = errors.New("agentcomm: mTLS dispatcher not configured (run `make secrets`)")

type Result struct {
	Accepted   bool
	StatusCode int
	Body       []byte
}

// Dispatch POSTs the signed job body to the agent at agentBaseURL.
func (d *Dispatcher) Dispatch(ctx context.Context, agentBaseURL string, body []byte, signatureB64 string) (*Result, error) {
	if !d.configured {
		return nil, ErrNotConfigured
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, agentBaseURL+"/v1/jobs", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Asterpanel-Signature", "ed25519="+signatureB64)
	req.Header.Set("X-Asterpanel-Key-Id", d.keyID)

	resp, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return &Result{
		Accepted:   resp.StatusCode == http.StatusAccepted || resp.StatusCode == http.StatusOK,
		StatusCode: resp.StatusCode,
		Body:       respBody,
	}, nil
}
