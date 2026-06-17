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
	RuntimeVersion  *string
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

type DatabaseInstance struct {
	ID                  uuid.UUID
	OrganizationID      uuid.UUID
	ApplicationID       uuid.NullUUID
	ServerNodeID        uuid.NullUUID
	Engine              string
	Version             *string
	Name                string
	DBUser              *string
	CredentialsSecretID uuid.NullUUID
	Host                *string
	Port                *int
	Status              string
	SizeMB              *int64
	CreatedAt           time.Time
}

type Domain struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	FQDN           string
	Status         string
	VerifiedAt     *time.Time
	AutoRenew      bool
	CreatedAt      time.Time
}

type DNSRecord struct {
	ID        uuid.UUID
	ZoneID    uuid.UUID
	ZoneName  string // joined from dns_zones for convenience
	Name      string
	Type      string
	Content   string
	TTL       int
	Priority  *int
	Proxied   bool
	CreatedAt time.Time
}

type Certificate struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	DomainID       uuid.NullUUID
	Domain         string
	Issuer         string
	Status         string
	AutoRenew      bool
	ExpiresAt      *time.Time
	CreatedAt      time.Time
}

type Mailbox struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Address        string
	QuotaMB        int
	UsedMB         int
	Status         string
	CreatedAt      time.Time
}

type MailForwarder struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Source         string
	Destinations   []string
	IsCatchall     bool
	CreatedAt      time.Time
}

type MailAutoresponder struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Address        string
	Subject        string
	Body           string
	IntervalDays   int
	StartDate      *time.Time
	EndDate        *time.Time
	Enabled        bool
	CreatedAt      time.Time
}

type MailFilter struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Address        string
	Name           string
	Field          string
	Op             string
	Value          string
	Action         string
	ActionArg      string
	Position       int
	Enabled        bool
	CreatedAt      time.Time
}

type Redirect struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	SourceDomain   string
	SourcePath     string
	TargetURL      string
	StatusCode     int
	CreatedAt      time.Time
}

type Backup struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	ApplicationID  uuid.NullUUID
	Type           string
	Trigger        string
	Status         string
	StorageBackend string
	SizeBytes      *int64
	Checksum       *string
	CreatedAt      time.Time
}

type CronJob struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Schedule       string
	Command        string
	Enabled        bool
	LastRunAt      *time.Time
	LastStatus     *string
	CreatedAt      time.Time
}

type FtpAccount struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Username       string
	Protocol       string
	HomeDirectory  string
	Status         string
	CreatedAt      time.Time
}

type EnvVar struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Key            string
	Value          string
	IsBuildTime    bool
	CreatedAt      time.Time
}

type SecretMeta struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Key            string
	Version        int
	UpdatedAt      time.Time
}

type FirewallRule struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Action         string
	Source         string
	Port           string
	Note           *string
	CreatedAt      time.Time
}

type WafRule struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	MatchType      string
	Pattern        string
	Note           *string
	CreatedAt      time.Time
}

type Webhook struct {
	ID              uuid.UUID
	OrganizationID  uuid.UUID
	URL             string
	Secret          string
	Events          []string
	Active          bool
	LastStatus      *int
	LastDeliveredAt *time.Time
	CreatedAt       time.Time
}
