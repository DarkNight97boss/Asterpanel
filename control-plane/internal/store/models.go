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

// MailboxApply is the per-mailbox data the declarative mail.mailbox.apply job
// needs: address, quota, status and the id of the secret holding its password.
type MailboxApply struct {
	ID       uuid.UUID
	Address  string
	QuotaMB  int
	Status   string
	SecretID uuid.NullUUID
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

type DirectoryPrivacy struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Domain         string
	Path           string
	Username       string
	PasswordHash   string
	CreatedAt      time.Time
}

type SitePhpSetting struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	WebsiteID      uuid.UUID
	Directive      string
	Value          string
	CreatedAt      time.Time
}

type SpamSettings struct {
	OrganizationID uuid.UUID
	RejectScore    int
	AddHeaderScore int
	Greylisting    bool
}

type SpamRule struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Kind           string
	Value          string
	CreatedAt      time.Time
}

type Dnssec struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Domain         string
	DsRecord       string
	Algorithm      int
	Enabled        bool
	CreatedAt      time.Time
}

type HotlinkProtection struct {
	ID              uuid.UUID
	OrganizationID  uuid.UUID
	Domain          string
	AllowedReferers []string
	Extensions      []string
	CreatedAt       time.Time
}

type DdnsHost struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	DomainID       uuid.UUID
	Name           string
	Token          string
	LastIP         *string
	UpdatedAt      *time.Time
	CreatedAt      time.Time
}

type DBRemoteHost struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	DatabaseID     uuid.UUID
	Host           string
	CreatedAt      time.Time
}

type DBUser struct {
	ID                  uuid.UUID
	OrganizationID      uuid.UUID
	DatabaseID          uuid.UUID
	Username            string
	HostScope           string
	Privileges          []string
	CredentialsSecretID uuid.NullUUID
	CreatedAt           time.Time
}

type Subdomain struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Kind           string
	FQDN           string
	DocumentRoot   string
	TargetURL      string
	Status         string
	CreatedAt      time.Time
}

type SSHKey struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Name           string
	KeyType        string
	PublicKey      string
	Fingerprint    string
	CreatedAt      time.Time
}

type GitRepo struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	WebsiteID      uuid.UUID
	Branch         string
	CloneURL       string
	CreatedAt      time.Time
}

type StagingEnvironment struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	WebsiteID      uuid.UUID
	Status         string
	LastJobID      uuid.NullUUID
	LastSyncedAt   *time.Time
	CreatedAt      time.Time
}

type MailList struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Address        string
	CreatedAt      time.Time
}

type MailListMember struct {
	ID        uuid.UUID
	ListID    uuid.UUID
	Email     string
	CreatedAt time.Time
}

type MailListForApply struct {
	Address string
	Members []string
}

type WebdavAccount struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Domain         string
	Path           string
	Username       string
	PasswordHash   string
	Root           string
	CreatedAt      time.Time
}

type CaldavAccount struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Username       string
	PasswordHash   string
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

type CloudflareAccount struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Label          string
	TokenCT        []byte
	TokenNonce     []byte
	TokenKeyID     string
	VerifiedAt     *time.Time
	CreatedAt      time.Time
}

type SSOProvider struct {
	ID                uuid.UUID
	OrganizationID    uuid.UUID
	Name              string
	Issuer            string
	ClientID          string
	ClientSecretCT    []byte
	ClientSecretNonce []byte
	ClientSecretKeyID string
	AllowedDomains    string
	Enabled           bool
	CreatedAt         time.Time
}

type BillingPlan struct {
	ID          uuid.UUID
	Code        string
	Name        string
	Description *string
	PriceCents  int
	Currency    string
	Interval    string
	Limits      map[string]int
	IsActive    bool
	CreatedAt   time.Time
	OwnerOrgID  uuid.NullUUID // NULL = platform plan; set = reseller-owned
}

type Application struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	WebsiteID      uuid.NullUUID
	ServerNodeID   uuid.NullUUID
	Name           string
	Runtime        string
	RepoURL        *string
	RepoBranch     string
	InstallCommand *string
	BuildCommand   *string
	StartCommand   *string
	Status         string
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
