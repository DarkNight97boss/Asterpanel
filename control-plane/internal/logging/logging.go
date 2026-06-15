// Package logging provides a structured slog logger with secret redaction.
package logging

import (
	"context"
	"log/slog"
	"os"
	"strings"
)

// New builds a structured logger. format is "json" or "text".
func New(level, format string) *slog.Logger {
	opts := &slog.HandlerOptions{
		Level:       parseLevel(level),
		ReplaceAttr: redact,
	}
	var h slog.Handler
	if strings.EqualFold(format, "text") {
		h = slog.NewTextHandler(os.Stdout, opts)
	} else {
		h = slog.NewJSONHandler(os.Stdout, opts)
	}
	return slog.New(h)
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// sensitiveKeys are never emitted in logs, regardless of value.
var sensitiveKeys = map[string]struct{}{
	"password": {}, "password_hash": {}, "secret": {}, "token": {},
	"refresh_token": {}, "access_token": {}, "authorization": {},
	"jwt": {}, "private_key": {}, "signature": {}, "ciphertext": {},
	"totp": {}, "totp_secret": {}, "master_key": {}, "enrollment_token": {},
}

// redact replaces the value of any sensitive attribute with "[REDACTED]".
func redact(_ []string, a slog.Attr) slog.Attr {
	if _, ok := sensitiveKeys[strings.ToLower(a.Key)]; ok {
		return slog.String(a.Key, "[REDACTED]")
	}
	return a
}

type ctxKey struct{}

// WithLogger stores a logger in the context.
func WithLogger(ctx context.Context, l *slog.Logger) context.Context {
	return context.WithValue(ctx, ctxKey{}, l)
}

// From returns the request-scoped logger, or the default.
func From(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(ctxKey{}).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}
