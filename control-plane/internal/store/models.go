package store

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID               uuid.UUID
	Email            string
	EmailVerifiedAt  *time.Time
	PasswordHash     string
	FullName         *string
	Status           string
	FailedLoginCount int
	LockedUntil      *time.Time
	IsSuperadmin     bool
	LastLoginAt      *time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

type Organization struct {
	ID            uuid.UUID
	Slug          string
	Name          string
	Status        string
	BillingPlanID uuid.NullUUID
	CreatedAt     time.Time
}

type Membership struct {
	ID             uuid.UUID
	UserID         uuid.UUID
	OrganizationID uuid.UUID
	RoleID         uuid.UUID
	Status         string
}

type Session struct {
	ID             uuid.UUID
	UserID         uuid.UUID
	OrganizationID uuid.NullUUID
	UserAgent      *string
	IP             *string
	MFASatisfied   bool
	CreatedAt      time.Time
	LastSeenAt     time.Time
	ExpiresAt      time.Time
	RevokedAt      *time.Time
}

type RefreshToken struct {
	ID          uuid.UUID
	SessionID   uuid.UUID
	UserID      uuid.UUID
	FamilyID    uuid.UUID
	TokenHash   []byte
	PrevTokenID uuid.NullUUID
	IssuedAt    time.Time
	ExpiresAt   time.Time
	RotatedAt   *time.Time
	RevokedAt   *time.Time
}

type APIToken struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	UserID         uuid.NullUUID
	Name           string
	Prefix         string
	Scopes         []string
	LastUsedAt     *time.Time
	ExpiresAt      *time.Time
	RevokedAt      *time.Time
	CreatedAt      time.Time
}

type ServerNode struct {
	ID              uuid.UUID
	OrganizationID  uuid.UUID
	Name            string
	Hostname        string
	Region          *string
	IPAddress       *string
	AgentVersion    *string
	Status          string
	Labels          json.RawMessage
	Capabilities    json.RawMessage
	CertFingerprint *string
	LastHeartbeatAt *time.Time
	EnrolledAt      *time.Time
	CreatedAt       time.Time
}

type AgentRegistration struct {
	ID             uuid.UUID
	ServerNodeID   uuid.UUID
	OrganizationID uuid.UUID
	Status         string
	ExpiresAt      time.Time
	UsedAt         *time.Time
	CreatedAt      time.Time
}

type Website struct {
	ID              uuid.UUID
	OrganizationID  uuid.UUID
	ServerNodeID    uuid.NullUUID
	PrimaryDomainID uuid.NullUUID
	Name            string
	Runtime         string
	Status          string
	SSLEnabled      bool
	SSLStatus       string
	CreatedAt       time.Time
}

type Job struct {
	ID             uuid.UUID
	OrganizationID uuid.NullUUID
	ServerNodeID   uuid.NullUUID
	Type           string
	Status         string
	Nonce          string
	Signature      string
	SigningKeyID   string
	IssuedAt       time.Time
	ExpiresAt      time.Time
	CreatedAt      time.Time
}
