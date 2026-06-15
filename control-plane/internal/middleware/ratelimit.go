package middleware

import (
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/logging"
)

// RateLimiter is a fixed-window limiter backed by Redis (INCR + EXPIRE). It
// fails open on Redis errors (availability over strictness) but logs them.
type RateLimiter struct {
	rdb    *redis.Client
	limit  int
	window time.Duration
}

func NewRateLimiter(rdb *redis.Client, limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{rdb: rdb, limit: limit, window: window}
}

// For returns a middleware that limits by client IP under the given bucket name.
func (rl *RateLimiter) For(bucket string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if rl == nil || rl.rdb == nil {
				next.ServeHTTP(w, r)
				return
			}
			ctx := r.Context()
			key := "rl:" + bucket + ":" + clientIP(r)

			count, err := rl.rdb.Incr(ctx, key).Result()
			if err != nil {
				logging.From(ctx).Warn("ratelimit: redis unavailable, failing open", "error", err)
				next.ServeHTTP(w, r)
				return
			}
			if count == 1 {
				_ = rl.rdb.Expire(ctx, key, rl.window).Err()
			}
			if count > int64(rl.limit) {
				w.Header().Set("Retry-After", strconv.Itoa(int(rl.window.Seconds())))
				httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "too many requests")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
