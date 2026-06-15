SHELL := /bin/bash
COMPOSE := docker compose

ADMIN_EMAIL    ?= admin@asterpanel.local
ADMIN_PASSWORD ?= ChangeMe!123
ADMIN_ORG      ?= acme
DB_URL         ?= postgres://asterpanel:asterpanel_dev_pw@postgres:5432/asterpanel?sslmode=disable

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.PHONY: secrets
secrets: ## Generate dev CA, mTLS certs and Ed25519 job keys into ./secrets
	@bash scripts/gen-secrets.sh ./secrets

.PHONY: up
up: ## Build and start the full stack
	@$(COMPOSE) up -d --build

.PHONY: down
down: ## Stop the stack
	@$(COMPOSE) down

.PHONY: clean
clean: ## Stop the stack and remove volumes
	@$(COMPOSE) down -v

.PHONY: logs
logs: ## Tail service logs
	@$(COMPOSE) logs -f --tail=100

.PHONY: ps
ps: ## Show running services
	@$(COMPOSE) ps

.PHONY: migrate
migrate: ## Apply database migrations
	@$(COMPOSE) run --rm migrate

.PHONY: migrate-down
migrate-down: ## Roll back the most recent migration
	@$(COMPOSE) run --rm migrate -path=/migrations -database=$(DB_URL) down 1

.PHONY: seed
seed: ## Load reference data and create the admin user
	@$(COMPOSE) exec -T postgres psql -U asterpanel -d asterpanel < db/seed.sql
	@$(COMPOSE) exec -T control-plane /controlplane create-admin \
		--email "$(ADMIN_EMAIL)" --password "$(ADMIN_PASSWORD)" --org "$(ADMIN_ORG)" --superadmin
	@echo "✓ admin ready: $(ADMIN_EMAIL) / $(ADMIN_PASSWORD)"

.PHONY: test
test: test-go test-rust test-web test-policies ## Run every test suite

.PHONY: test-go
test-go: ## Control-plane Go unit tests
	@cd control-plane && go test ./...

.PHONY: test-rust
test-rust: ## Node-agent Rust tests
	@cd node-agent && cargo test

.PHONY: test-web
test-web: ## Web unit tests
	@cd web && npm test

.PHONY: test-policies
test-policies: ## OPA policy tests
	@opa test policies -v

.PHONY: fmt
fmt: ## Format Go and Rust sources
	@cd control-plane && gofmt -w .
	@cd node-agent && cargo fmt || true
