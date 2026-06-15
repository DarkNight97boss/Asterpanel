package middleware

import (
	"net/http"
	"runtime/debug"

	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/logging"
)

// RequestID assigns/propagates an X-Request-Id and binds a request-scoped logger.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = uuid.NewString()
		}
		w.Header().Set("X-Request-Id", id)

		ctx := withRequestID(r.Context(), id)
		l := logging.From(ctx).With("request_id", id, "method", r.Method, "path", r.URL.Path)
		ctx = logging.WithLogger(ctx, l)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Recover converts panics into a 500 and logs the stack (no secrets).
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				logging.From(r.Context()).Error("panic recovered",
					"panic", rec, "stack", string(debug.Stack()))
				httpx.Error(w, http.StatusInternalServerError, "internal_error", "internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// SecureHeaders sets a strict set of security response headers.
func SecureHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		// API serves JSON only; a tight CSP is still defense-in-depth.
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
		next.ServeHTTP(w, r)
	})
}
