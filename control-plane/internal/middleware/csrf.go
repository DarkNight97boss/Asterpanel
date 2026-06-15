package middleware

import (
	"crypto/subtle"
	"net/http"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
)

// CSRFCookieName is the double-submit cookie the web client echoes in a header.
const CSRFCookieName = "asterpanel_csrf"

// CSRF enforces the double-submit-cookie pattern on state-changing methods used
// by cookie-authenticated flows (refresh, logout). Bearer-token API calls are
// not cookie-authenticated and are unaffected by CSRF, but applying this to
// cookie flows is required defense.
func CSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodTrace:
			next.ServeHTTP(w, r)
			return
		}
		cookie, err := r.Cookie(CSRFCookieName)
		header := r.Header.Get("X-CSRF-Token")
		if err != nil || header == "" ||
			subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(header)) != 1 {
			httpx.Error(w, http.StatusForbidden, "csrf_failed", "missing or invalid CSRF token")
			return
		}
		next.ServeHTTP(w, r)
	})
}
