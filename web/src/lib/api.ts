// Typed client for the AsterPanel control-plane API.
//
// Auth model: the short-lived access token lives in memory (never localStorage),
// the rotating refresh token is an HttpOnly cookie the browser sends automatically.
// On a 401 we transparently rotate once and retry.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

let accessToken: string | null = null;
let csrfToken: string | null = null;

export function setTokens(at: string | null, csrf?: string | null) {
  accessToken = at;
  if (csrf !== undefined) csrfToken = csrf;
}

export function getAccessToken() {
  return accessToken;
}

// Generic helpers for read-mostly resource pages (typed at the call site).
export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}
export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body });
}
export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body });
}
export async function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };

async function request<T>(path: string, opts: RequestOptions = {}, retry = true): Promise<T> {
  const headers = new Headers(opts.headers);
  headers.set("Content-Type", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  if (csrfToken && path.startsWith("/api/v1/auth/refresh")) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers,
    credentials: "include",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401 && retry && !path.startsWith("/api/v1/auth/")) {
    if (await tryRefresh()) return request<T>(path, opts, false);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "error", err.message ?? res.statusText);
  }
  return data as T;
}

// --- Auth ---------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  full_name: string | null;
  superadmin: boolean;
  status: string;
  organization_id?: string;
}

export type LoginResult =
  | { mfaRequired: true; mfaToken: string; methods: string[] }
  | { mfaRequired: false; user: User };

interface LoginResponse {
  mfa_required?: boolean;
  mfa_token?: string;
  methods?: string[];
  access_token?: string;
  csrf_token?: string;
  user?: User;
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const data = await request<LoginResponse>(
    "/api/v1/auth/login",
    { method: "POST", body: { email, password } },
    false,
  );
  if (data.mfa_required) {
    return { mfaRequired: true, mfaToken: data.mfa_token!, methods: data.methods ?? [] };
  }
  setTokens(data.access_token!, data.csrf_token);
  return { mfaRequired: false, user: data.user! };
}

export async function verifyMfa(mfaToken: string, code: string): Promise<User> {
  const data = await request<LoginResponse>(
    "/api/v1/auth/mfa/verify",
    { method: "POST", body: { mfa_token: mfaToken, code } },
    false,
  );
  setTokens(data.access_token!, data.csrf_token);
  return data.user!;
}

async function tryRefresh(): Promise<boolean> {
  try {
    const data = await request<LoginResponse>("/api/v1/auth/refresh", { method: "POST" }, false);
    setTokens(data.access_token!, data.csrf_token);
    return true;
  } catch {
    setTokens(null, null);
    return false;
  }
}

/** Restore a session on app load using the refresh cookie. */
export async function bootstrap(): Promise<User | null> {
  if (!(await tryRefresh())) return null;
  try {
    const { user } = await request<{ user: User }>("/api/v1/me");
    return user;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await request("/api/v1/auth/logout", { method: "POST" }, false);
  } finally {
    setTokens(null, null);
  }
}

// --- Impersonation ------------------------------------------------------------

interface ImpersonateResponse {
  access_token: string;
  user: User;
  impersonating: boolean;
}

/** Start impersonating a user: swaps the in-memory access token for the
 *  impersonation token. The admin's refresh cookie is untouched, so
 *  stopImpersonation() (or a reload) reverts to the admin session. */
export async function startImpersonation(targetUserId: string): Promise<User> {
  const data = await request<ImpersonateResponse>(
    "/api/v1/admin/impersonate",
    { method: "POST", body: { target_user_id: targetUserId } },
    false,
  );
  setTokens(data.access_token); // swap access token only; keep csrf
  return data.user;
}

/** Stop impersonating: revoke the impersonation session and restore the admin
 *  session from the (untouched) refresh cookie. */
export async function stopImpersonation(): Promise<User | null> {
  try {
    await request("/api/v1/admin/impersonate/exit", { method: "POST" }, false);
  } catch {
    /* best-effort revoke */
  }
  setTokens(null, null);
  return bootstrap();
}

// --- Resources ----------------------------------------------------------------

export interface ServerNode {
  id: string;
  name: string;
  hostname: string;
  region: string | null;
  status: string;
  agent_version: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
}

export async function listNodes(): Promise<ServerNode[]> {
  const { nodes } = await request<{ nodes: ServerNode[] }>("/api/v1/nodes");
  return nodes ?? [];
}

export async function createNode(input: { name: string; hostname: string; region?: string }) {
  return request<{ node: ServerNode }>("/api/v1/nodes", { method: "POST", body: input });
}

export async function createEnrollment(nodeId: string) {
  return request<{ enrollment_token: string; expires_at: string; node_id: string }>(
    `/api/v1/nodes/${nodeId}/enroll`,
    { method: "POST" },
  );
}

export interface Website {
  id: string;
  name: string;
  runtime: string;
  status: string;
  server_node_id: string | null;
  ssl_enabled: boolean;
  ssl_status: string;
  created_at: string;
}

export async function listWebsites(): Promise<Website[]> {
  const { websites } = await request<{ websites: Website[] }>("/api/v1/websites");
  return websites ?? [];
}

export async function createWebsite(input: {
  name: string;
  domain: string;
  runtime: string;
  node_id: string;
  ssl_enabled?: boolean;
}) {
  return request<{ website: Website; job: { id: string; dispatched: boolean } }>(
    "/api/v1/websites",
    { method: "POST", body: input },
  );
}

// --- Domains & DNS ---------------------------------------------------------
export interface Domain {
  id: string;
  fqdn: string;
  status: string;
  verified_at: string | null;
  auto_renew: boolean;
  created_at: string;
}
export interface DnsRecord {
  id: string;
  zone: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  priority: number | null;
  proxied: boolean;
}
export async function listDomains(): Promise<Domain[]> {
  const { domains } = await request<{ domains: Domain[] }>("/api/v1/domains");
  return domains ?? [];
}
export async function listDnsRecords(): Promise<DnsRecord[]> {
  const { records } = await request<{ records: DnsRecord[] }>("/api/v1/dns");
  return records ?? [];
}
export async function createDomain(fqdn: string) {
  return apiPost<{ domain: Domain; job?: { id: string; dispatched: boolean } }>("/api/v1/domains", {
    fqdn,
  });
}
export async function createDnsRecord(input: {
  domain_id: string;
  name: string;
  type: string;
  content: string;
  ttl?: number;
  priority?: number;
}) {
  return apiPost<{ record: DnsRecord }>("/api/v1/dns", input);
}
export async function updateDnsRecord(
  id: string,
  input: { name: string; type: string; content: string; ttl?: number; priority?: number },
) {
  return apiPost<{ record: DnsRecord }>(`/api/v1/dns/${id}`, input);
}
export async function deleteDnsRecord(id: string) {
  return apiDelete<{ deleted: boolean }>(`/api/v1/dns/${id}`);
}

// --- Webmail (IMAP/SMTP gateway) -------------------------------------------
export interface Mailbox {
  id: string;
  address: string;
  quota_mb: number;
  used_mb: number;
  status: string;
}
export interface WebmailFolder {
  name: string;
}
export interface WebmailHeader {
  uid: number;
  from: string;
  subject: string;
  date: string;
  seen: boolean;
}
export interface WebmailMessage {
  uid: number;
  from: string;
  subject: string;
  date: string;
  body_text: string;
  body_html: string;
}
export async function listMailboxes(): Promise<Mailbox[]> {
  const { mailboxes } = await apiGet<{ mailboxes: Mailbox[] }>("/api/v1/email/mailboxes");
  return mailboxes ?? [];
}
export async function webmailFolders(mailboxId: string): Promise<WebmailFolder[]> {
  const { folders } = await apiGet<{ folders: WebmailFolder[] }>(`/api/v1/webmail/${mailboxId}/folders`);
  return folders ?? [];
}
export async function webmailMessages(mailboxId: string, folder: string): Promise<WebmailHeader[]> {
  const { messages } = await apiGet<{ messages: WebmailHeader[] }>(
    `/api/v1/webmail/${mailboxId}/messages?folder=${encodeURIComponent(folder)}`,
  );
  return messages ?? [];
}
export async function webmailMessage(mailboxId: string, folder: string, uid: number): Promise<WebmailMessage> {
  const { message } = await apiGet<{ message: WebmailMessage }>(
    `/api/v1/webmail/${mailboxId}/messages/${uid}?folder=${encodeURIComponent(folder)}`,
  );
  return message;
}
export async function webmailSend(mailboxId: string, input: { to: string; subject: string; body: string }) {
  return apiPost<{ sent: boolean }>(`/api/v1/webmail/${mailboxId}/send`, input);
}

// --- Databases (SQL) -------------------------------------------------------
export interface DatabaseInstance {
  id: string;
  engine: string;
  version: string | null;
  name: string;
  db_user: string | null;
  host: string | null;
  port: number | null;
  status: string;
  size_mb: number | null;
  created_at: string;
}
export async function listDatabases(): Promise<DatabaseInstance[]> {
  const { databases } = await request<{ databases: DatabaseInstance[] }>("/api/v1/databases");
  return databases ?? [];
}
export async function createDatabase(input: { engine: string; name: string }) {
  return request<{ database: DatabaseInstance; credentials?: { user: string; password: string } }>(
    "/api/v1/databases",
    { method: "POST", body: input },
  );
}

// --- FTP / SFTP accounts ---------------------------------------------------
export interface FtpAccount {
  id: string;
  username: string;
  protocol: string;
  home_directory: string;
  website: string | null;
  status: string;
  created_at: string;
}
export async function listFtpAccounts(): Promise<FtpAccount[]> {
  const { accounts } = await request<{ accounts: FtpAccount[] }>("/api/v1/ftp-accounts");
  return accounts ?? [];
}
export async function createFtpAccount(input: {
  username: string;
  protocol: string;
  home_directory: string;
}) {
  return request<{ account: FtpAccount; password?: string }>("/api/v1/ftp-accounts", {
    method: "POST",
    body: input,
  });
}

// --- Env & Secrets ---------------------------------------------------------
export interface EnvVar {
  id: string;
  key: string;
  value: string;
  is_build_time: boolean;
}
export interface SecretMeta {
  id: string;
  key: string;
  version: number;
  updated_at: string;
}
export async function listEnv(): Promise<EnvVar[]> {
  const { variables } = await request<{ variables: EnvVar[] }>("/api/v1/env");
  return variables ?? [];
}
export async function listSecrets(): Promise<SecretMeta[]> {
  const { secrets } = await request<{ secrets: SecretMeta[] }>("/api/v1/secrets");
  return secrets ?? [];
}

// --- Backups ---------------------------------------------------------------
export interface Backup {
  id: string;
  type: string;
  trigger: string;
  status: string;
  size_bytes: number | null;
  checksum: string | null;
  storage_backend: string;
  created_at: string;
}
export async function listBackups(): Promise<Backup[]> {
  const { backups } = await request<{ backups: Backup[] }>("/api/v1/backups");
  return backups ?? [];
}
export async function createBackup(input: { type: string }) {
  return request<{ backup: Backup }>("/api/v1/backups", { method: "POST", body: input });
}
