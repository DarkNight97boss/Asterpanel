# syntax=docker/dockerfile:1
# Build context is the repo root (see docker-compose.yml).

FROM golang:1.23-alpine AS build
WORKDIR /src/control-plane
ENV CGO_ENABLED=0 GOFLAGS=-mod=mod
# Resolve modules first for better layer caching, then build.
COPY control-plane/go.mod ./
RUN go mod download all 2>/dev/null || true
COPY control-plane/ ./
RUN go build -trimpath -ldflags "-s -w" -o /out/controlplane ./cmd/controlplane

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/controlplane /controlplane
COPY api/openapi.yaml /api/openapi.yaml
ENV OPENAPI_PATH=/api/openapi.yaml
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/controlplane"]
CMD ["serve"]
