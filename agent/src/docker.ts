import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import type { ApmReport, JobPayloads, JobResult, ToolName, WorkloadSpec, WpInventory } from "../../src/platform/protocol";
import type { Driver, Log } from "./driver";

/**
 * Production driver: one isolated stack per workload on a plain Docker host.
 *
 *   aster-traefik                 edge proxy, :80/:443, Let's Encrypt (HTTP-01)
 *   aster-<slug>                  the workload (WordPress / app / nginx / db engine)
 *   aster-<slug>-db               MariaDB of a WordPress site
 *   network aster-<slug>          private to the stack
 *   network aster-t-<tenant>      shared by one customer's apps and databases
 *   network aster-proxy           Traefik ⇄ web containers only
 *
 * Security notes
 * - Commands are spawned with argv arrays, never through a shell, so values
 *   coming from the control plane cannot inject commands. Where a shell is
 *   needed *inside* a container, inputs travel as environment variables.
 * - User build commands run in a throw-away container with resource limits
 *   and no access to the Docker socket or other tenants' networks.
 */

const PROXY_NET = "aster-proxy";
/** Bump when the proxy's static flags change: an older container is re-created. */
const PROXY_VERSION = "3";
const BAD_BOTS = "(?i)(semrush|ahrefs|mj12bot|dotbot|petalbot|bytespider|blexbot|megaindex|seekport|zoominfo|dataforseo|serpstat|scrapy|python-requests|go-http-client|curl/|wget/|libwww|httpclient|nikto|sqlmap|masscan|zgrab|nmap)";
const AI_BOTS = "(?i)(gptbot|chatgpt-user|oai-searchbot|claudebot|claude-web|anthropic-ai|ccbot|google-extended|perplexitybot|amazonbot|applebot-extended|bytespider|cohere-ai|diffbot|facebookbot|meta-externalagent|omgili|youbot)";
const SLUG = /^[a-z0-9][a-z0-9-]{1,48}$/;
const ID = /^[0-9a-f-]{36}$/i;
const REL_PATH = /^(?!\/)(?!.*\.\.)[\w./-]*$/;

/** One CSV record (RFC 4180 quoting) → cells. psql --csv never breaks a record across lines unless a value does. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

const DB_IMAGES = {
  mysql: (v: string) => `mariadb:${v || "11"}`,
  postgres: (v: string) => `postgres:${v || "17"}-alpine`,
  redis: (v: string) => `redis:${v || "7"}-alpine`,
} as const;
const DB_DATA_DIR = { mysql: "/var/lib/mysql", postgres: "/var/lib/postgresql/data", redis: "/data" } as const;

type RunOpts = { env?: Record<string, string>; input?: string; timeoutMs?: number; quiet?: boolean };

export class DockerDriver implements Driver {
  readonly name = "docker";
  constructor(private opts: { dataDir: string; acmeEmail: string }) {}

  // ─── plumbing ────────────────────────────────────────────────────────────

  private exec(cmd: string, args: string[], log?: Log, { env, input, timeoutMs = 15 * 60_000, quiet }: RunOpts = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(cmd, args, { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
        if (!quiet) for (const line of `${stdout}${stderr}`.split("\n").slice(-40)) if (line.trim()) log?.(`  ${line}`);
        if (err) reject(new Error(`${cmd} ${args[0]} failed: ${(stderr || err.message).trim().split("\n").slice(-3).join(" ")}`));
        else resolve(stdout);
      });
      if (input !== undefined) child.stdin?.end(input);
    });
  }
  private docker = (args: string[], log?: Log, opts?: RunOpts) => this.exec("docker", args, log, opts);

  private async exists(kind: "container" | "network" | "volume" | "image", name: string) {
    return this.docker([kind, "inspect", name], undefined, { quiet: true }).then(() => true, () => false);
  }
  private async ensureNetwork(name: string) {
    if (!(await this.exists("network", name))) await this.docker(["network", "create", name]);
  }
  private async rmContainer(name: string) {
    if (await this.exists("container", name)) await this.docker(["rm", "-f", name], undefined, { quiet: true });
  }

  private check(spec: WorkloadSpec) {
    if (!SLUG.test(spec.slug)) throw new Error("Invalid workload slug");
    if (!/^[a-z0-9]{1,16}$/.test(spec.tenant)) throw new Error("Invalid tenant id");
    for (const d of spec.domains) if (!/^[a-z0-9.-]{1,253}$/.test(d)) throw new Error(`Invalid hostname ${d}`);
    return { name: `aster-${spec.slug}`, net: `aster-${spec.slug}`, tenantNet: `aster-t-${spec.tenant}` };
  }

  private limits = (spec: WorkloadSpec) => ["--memory", `${spec.resources.memoryMb}m`, "--cpus", String(spec.resources.cpus), "--pids-limit", "512", "--restart", "unless-stopped"];

  /** Traefik labels: routing on the spec's hostnames plus its edge rules. */
  private route(spec: WorkloadSpec, port: number): string[] {
    if (!spec.domains.length) return [];
    const r = `aster-${spec.slug}`;
    const hosts = `(${spec.domains.map((d) => `Host(\`${d}\`)`).join(" || ")})`;
    const bots = spec.bots;
    // A blocked user agent simply matches no router: the proxy answers 404
    // and the request never reaches the site.
    const blocked = [bots?.blockBad && BAD_BOTS, bots?.blockAi && AI_BOTS].filter(Boolean).map((re) => ` && !HeaderRegexp(\`User-Agent\`, \`${re}\`)`).join("");
    const rule = `${hosts}${blocked}`;
    const labels = [
      "traefik.enable=true",
      `traefik.docker.network=${PROXY_NET}`,
      `traefik.http.routers.${r}.rule=${rule}`,
      `traefik.http.routers.${r}.entrypoints=websecure`,
      `traefik.http.routers.${r}.tls.certresolver=le`,
      `traefik.http.services.${r}.loadbalancer.server.port=${port}`,
    ];
    const middlewares: string[] = [];
    if (spec.cdn?.enabled || spec.kind !== "wordpress") {
      labels.push(`traefik.http.middlewares.${r}-gz.compress=true`);
      middlewares.push(`${r}-gz`);
    }
    if (bots && bots.ratePerMinute > 0) {
      labels.push(`traefik.http.middlewares.${r}-rate.ratelimit.average=${bots.ratePerMinute}`, `traefik.http.middlewares.${r}-rate.ratelimit.period=1m`, `traefik.http.middlewares.${r}-rate.ratelimit.burst=${Math.max(20, Math.round(bots.ratePerMinute / 4))}`);
      middlewares.push(`${r}-rate`);
    }
    if (bots?.protectLogin) {
      // Brute-force targets get their own, much tighter budget: 10 requests a minute per IP.
      labels.push(
        `traefik.http.routers.${r}-login.rule=${rule} && (Path(\`/wp-login.php\`) || Path(\`/xmlrpc.php\`))`,
        `traefik.http.routers.${r}-login.priority=1000`,
        `traefik.http.routers.${r}-login.entrypoints=websecure`,
        `traefik.http.routers.${r}-login.tls.certresolver=le`,
        `traefik.http.routers.${r}-login.service=${r}`,
        `traefik.http.routers.${r}-login.middlewares=${r}-login-rate`,
        `traefik.http.middlewares.${r}-login-rate.ratelimit.average=10`,
        `traefik.http.middlewares.${r}-login-rate.ratelimit.period=1m`,
        `traefik.http.middlewares.${r}-login-rate.ratelimit.burst=5`,
        `traefik.http.routers.${r}.service=${r}`,
      );
    }
    const deny = (spec.denyIps ?? []).filter((ip) => /^[0-9a-f.:/]{2,49}$/i.test(ip));
    if (deny.length) {
      // Traefik only ships an allow-list; denying needs the denyip plugin (see ensureProxy).
      labels.push(`traefik.http.middlewares.${r}-deny.plugin.denyip.ipDenyList=${deny.join(",")}`);
      middlewares.push(`${r}-deny`);
    }
    (spec.redirects ?? []).forEach((rd, i) => {
      if (!/^\/[\w\-./~%+@:]*$/.test(rd.from) || /[\s"'`<>]/.test(rd.to)) return;
      const from = rd.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\/$/, "");
      labels.push(
        `traefik.http.middlewares.${r}-rd${i}.redirectregex.regex=^(https?://[^/]+)${from}/?$`, // plain `docker run --label`: no Compose-style $$ escaping
        `traefik.http.middlewares.${r}-rd${i}.redirectregex.replacement=${rd.to.startsWith("/") ? "${1}" + rd.to : rd.to}`,
        `traefik.http.middlewares.${r}-rd${i}.redirectregex.permanent=${rd.code === 301}`,
      );
      middlewares.push(`${r}-rd${i}`);
    });
    if (middlewares.length) labels.push(`traefik.http.routers.${r}.middlewares=${middlewares.join(",")}`);
    return labels.flatMap((l) => ["--label", l]);
  }

  private get accessLogDir() {
    return path.join(this.opts.dataDir, "proxy-logs");
  }

  private async ensureProxy(log: Log) {
    await this.ensureNetwork(PROXY_NET);
    if (await this.exists("container", "aster-traefik")) {
      const version = (await this.docker(["inspect", "-f", '{{ index .Config.Labels "aster.proxy.version" }}', "aster-traefik"], undefined, { quiet: true }).catch(() => "")).trim();
      if (version === PROXY_VERSION) return;
      log("upgrading edge proxy"); // certificates live in a volume and survive
      await this.rmContainer("aster-traefik");
    }
    await mkdir(this.accessLogDir, { recursive: true });
    log("starting edge proxy (traefik)");
    await this.docker([
      "run", "-d", "--name", "aster-traefik", "--restart", "unless-stopped", "--network", PROXY_NET,
      "-p", "80:80", "-p", "443:443",
      "-v", "/var/run/docker.sock:/var/run/docker.sock:ro", "-v", "aster-traefik-acme:/acme", "-v", `${this.accessLogDir}:/logs`,
      "--label", `aster.proxy.version=${PROXY_VERSION}`,
      "traefik:v3.1",
      "--accesslog=true", "--accesslog.format=json", "--accesslog.filepath=/logs/access.log", "--accesslog.bufferingsize=50",
      "--accesslog.fields.defaultmode=drop", "--accesslog.fields.names.RouterName=keep", "--accesslog.fields.names.RequestPath=keep", "--accesslog.fields.names.DownstreamStatus=keep", "--accesslog.fields.names.Duration=keep", "--accesslog.fields.names.StartUTC=keep",
      "--experimental.plugins.denyip.modulename=github.com/kevtainer/denyip", "--experimental.plugins.denyip.version=v1.0.0",
      "--providers.docker=true", "--providers.docker.exposedbydefault=false", `--providers.docker.network=${PROXY_NET}`,
      "--entrypoints.web.address=:80", "--entrypoints.websecure.address=:443",
      "--entrypoints.web.http.redirections.entrypoint.to=websecure", "--entrypoints.web.http.redirections.entrypoint.scheme=https",
      "--certificatesresolvers.le.acme.httpchallenge=true", "--certificatesresolvers.le.acme.httpchallenge.entrypoint=web",
      `--certificatesresolvers.le.acme.email=${this.opts.acmeEmail}`, "--certificatesresolvers.le.acme.storage=/acme/acme.json",
    ], log);
  }

  private async diskUsedMb(volumes: string[]) {
    let total = 0;
    for (const v of volumes) {
      const out = await this.docker(["run", "--rm", "-v", `${v}:/v:ro`, "alpine:3", "du", "-sm", "/v"], undefined, { quiet: true }).catch(() => "0");
      total += parseInt(out, 10) || 0;
    }
    return total;
  }

  // ─── containers per kind ─────────────────────────────────────────────────

  private wpEnv(spec: WorkloadSpec) {
    return { WORDPRESS_DB_HOST: `aster-${spec.slug}-db`, WORDPRESS_DB_USER: "wordpress", WORDPRESS_DB_NAME: "wordpress", WORDPRESS_DB_PASSWORD: spec.wordpress!.dbPassword };
  }
  private envArgs = (env: Record<string, string>) => Object.keys(env).flatMap((k) => ["-e", k]);

  private async runWordPressDb(spec: WorkloadSpec, log: Log) {
    const { name, net } = this.check(spec);
    if (await this.exists("container", `${name}-db`)) return;
    log("starting database (mariadb:11)");
    const env = { MARIADB_DATABASE: "wordpress", MARIADB_USER: "wordpress", MARIADB_PASSWORD: spec.wordpress!.dbPassword, MARIADB_RANDOM_ROOT_PASSWORD: "1" };
    await this.docker(["run", "-d", "--name", `${name}-db`, "--network", net, "--restart", "unless-stopped", "--memory", "512m", "-v", `${name}-db:/var/lib/mysql`, ...this.envArgs(env), "mariadb:11"], log, { env });
  }

  private async runWordPress(spec: WorkloadSpec, log: Log) {
    const { name, net } = this.check(spec);
    const php = /^\d\.\d$/.test(spec.wordpress!.phpVersion) ? spec.wordpress!.phpVersion : "8.3";
    await this.rmContainer(name);
    log(`starting wordpress (php ${php})`);
    const env = { ...this.wpEnv(spec), ...spec.env };
    const direct = !spec.cache?.enabled && !spec.cdn?.enabled; // otherwise Traefik talks to the edge sidecar instead
    await this.docker(["run", "-d", "--name", name, "--network", net, ...this.limits(spec), "-v", `${name}-files:/var/www/html`, ...this.envArgs(env), ...(direct ? this.route(spec, 80) : []), `wordpress:php${php}-apache`], log, { env });
    if (direct) await this.docker(["network", "connect", PROXY_NET, name]);
    await this.syncCache(spec, log);
  }

  /**
   * Edge page cache: an nginx sidecar between Traefik and WordPress. It never
   * caches logged-in users, carts, admin, previews, POSTs or excluded paths,
   * and tells you what it did in the `X-Aster-Cache` response header.
   */
  private async syncCache(spec: WorkloadSpec, log: Log) {
    const { name, net } = this.check(spec);
    await this.rmContainer(`${name}-cache`);
    const pages = !!spec.cache?.enabled;
    const assets = !!spec.cdn?.enabled;
    if (!pages && !assets) return;
    const cache = spec.cache ?? { enabled: false, ttlMinutes: 60, bypass: [] };
    const ttl = Math.min(Math.max(Math.round(cache.ttlMinutes) || 60, 1), 10_080);
    const days = Math.min(Math.max(Math.round(spec.cdn?.maxAgeDays ?? 30), 1), 365);
    const excluded = cache.bypass.filter((p) => /^\/[\w\-./~%+@:]*$/.test(p)).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const conf = `proxy_cache_path /var/cache/nginx/site levels=1:2 keys_zone=site:20m max_size=1g inactive=7d use_temp_path=off;
map $http_cookie $aster_cookie_skip { default 0; "~*(wordpress_logged_in|wp-postpass|comment_author|woocommerce_items_in_cart|woocommerce_cart_hash|wp_woocommerce_session)" 1; }
map $request_uri $aster_uri_skip { default 0; "~*^/(wp-admin|wp-login\\.php|wp-json|xmlrpc\\.php|wp-cron\\.php|cart|checkout|my-account)" 1; "~*[?&](preview|s|add-to-cart)=" 1;${excluded.map((p) => ` "~^${p}" 1;`).join("")} }
server {
  listen 80;
  client_max_body_size 256m;
${assets ? `  location ~* \\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|pdf)$ {
    proxy_pass http://${name}:80;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_cache site;
    proxy_cache_key "asset$host$request_uri";
    proxy_cache_valid 200 ${days}d;
    proxy_cache_lock on;
    proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
    proxy_ignore_headers Cache-Control Expires Set-Cookie;
    proxy_hide_header Set-Cookie;
    proxy_hide_header Cache-Control;
    proxy_hide_header Expires;
    add_header Cache-Control "public, max-age=${days * 86400}" always;
    add_header X-Aster-CDN $upstream_cache_status always;
  }
` : ""}  location / {
    proxy_pass http://${name}:80;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    ${pages ? "proxy_cache site;" : "proxy_cache off;"}
    proxy_cache_key "$scheme$host$request_uri";
    proxy_cache_methods GET HEAD;
    proxy_cache_valid 200 301 ${ttl}m;
    proxy_cache_valid 404 1m;
    proxy_cache_bypass $aster_cookie_skip $aster_uri_skip;
    proxy_no_cache $aster_cookie_skip $aster_uri_skip;
    proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
    proxy_cache_background_update on;
    proxy_cache_lock on;
    proxy_ignore_headers Cache-Control Expires;
    add_header X-Aster-Cache $upstream_cache_status always;
  }
}
`;
    const dir = path.join(this.opts.dataDir, "cache", spec.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "default.conf"), conf);
    log(`edge sidecar: pages ${pages ? `cached ${ttl} min (${excluded.length} excluded)` : "not cached"}, static assets ${assets ? `cached ${days} d` : "not cached"}`);
    await this.docker(["run", "-d", "--name", `${name}-cache`, "--network", net, "--restart", "unless-stopped", "--memory", "256m", "--pids-limit", "128",
      "-v", `${dir}/default.conf:/etc/nginx/conf.d/default.conf:ro`, "-v", `${name}-cache:/var/cache/nginx`, ...this.route(spec, 80), "nginx:alpine"], log);
    await this.docker(["network", "connect", PROXY_NET, `${name}-cache`]);
  }

  /**
   * SFTP = a tiny OpenSSH container chrooted to the site's files volume, as
   * www-data (uid 33), on its own published port. No shell, no other mounts.
   * Known limit: the SSH host key is regenerated when the container is
   * re-created, so clients may warn about a changed key after config changes.
   */
  private async syncSftp(spec: WorkloadSpec, log: Log) {
    const { name } = this.check(spec);
    await this.rmContainer(`${name}-sftp`);
    const sftp = spec.sftp;
    if (!sftp?.enabled) return;
    if (!Number.isInteger(sftp.port) || sftp.port < 1024 || sftp.port > 65535 || !/^[a-z0-9]{1,32}$/.test(sftp.username)) throw new Error("Invalid SFTP settings");
    log(`enabling SFTP on port ${sftp.port}`);
    // Public keys: the image authorises every *.pub it finds in ~/.ssh/keys.
    const keyDir = path.join(this.opts.dataDir, "sftp", spec.slug);
    await rm(keyDir, { recursive: true, force: true });
    await mkdir(keyDir, { recursive: true });
    const keys = (sftp.keys ?? []).filter((k) => /^[a-z0-9@.-]+ [A-Za-z0-9+/=]+$/.test(k));
    for (const [i, k] of keys.entries()) await writeFile(path.join(keyDir, `key${i}.pub`), `${k}\n`);
    // Credentials travel in the environment (SFTP_USERS), never on the command line.
    const env = { SFTP_USERS: `${sftp.username}:${sftp.password}:33:33` };
    await this.docker(
      ["run", "-d", "--name", `${name}-sftp`, "--restart", "unless-stopped", "--network", "none", "--memory", "128m", "--pids-limit", "64",
        "-p", `${sftp.port}:22`, "-v", `${name}-files:/home/${sftp.username}/site`, "-v", `${keyDir}:/home/${sftp.username}/.ssh/keys:ro`, "-e", "SFTP_USERS", "atmoz/sftp:alpine"],
      log,
      { env },
    );
  }

  /** Runs WP-CLI against a site, as www-data, sharing its files and network. */
  private wp(spec: WorkloadSpec, args: string[], log?: Log, extraEnv: Record<string, string> = {}) {
    const { name, net } = this.check(spec);
    const env = { ...this.wpEnv(spec), ...extraEnv };
    return this.docker(["run", "--rm", "--user", "33:33", "--network", net, "--volumes-from", name, ...this.envArgs(env), "wordpress:cli", "wp", ...args], log, { env });
  }

  private async waitForWpDb(spec: WorkloadSpec, log: Log) {
    for (let i = 0; i < 40; i++) {
      if (await this.wp(spec, ["db", "check", "--quiet"], undefined).then(() => true, () => false)) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
    log("database did not become ready in time");
    throw new Error("Database did not become ready");
  }

  private async runDatabase(spec: WorkloadSpec, log: Log) {
    const { name, net, tenantNet } = this.check(spec);
    const db = spec.database!;
    await this.ensureNetwork(tenantNet);
    await this.rmContainer(name);
    const image = DB_IMAGES[db.engine](/^[\w.]*$/.test(db.version) ? db.version : "");
    log(`starting ${image}`);
    const env: Record<string, string> =
      db.engine === "mysql"
        ? { MARIADB_DATABASE: db.name, MARIADB_USER: db.user, MARIADB_PASSWORD: db.password, MARIADB_RANDOM_ROOT_PASSWORD: "1" }
        : db.engine === "postgres"
          ? { POSTGRES_DB: db.name, POSTGRES_USER: db.user, POSTGRES_PASSWORD: db.password }
          : { REDIS_PASSWORD: db.password };
    const cmd = db.engine === "redis" ? ["sh", "-c", 'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"'] : [];
    await this.docker(["run", "-d", "--name", name, "--network", net, ...this.limits(spec), "-v", `${name}-data:${DB_DATA_DIR[db.engine]}`, ...this.envArgs(env), image, ...cmd], log, { env });
    await this.docker(["network", "connect", tenantNet, name]);
  }

  // ─── Driver: lifecycle ───────────────────────────────────────────────────

  async create(spec: WorkloadSpec, log: Log): Promise<JobResult> {
    const { name, net } = this.check(spec);
    await this.ensureNetwork(net);
    if (spec.kind === "database") {
      await this.runDatabase(spec, log);
      return { runtime: { internalHost: name, dbName: spec.database!.name, dbUser: spec.database!.user, version: spec.database!.version } };
    }
    await this.ensureProxy(log);
    if (spec.kind !== "wordpress") return this.deploy(spec, log);

    const wp = spec.wordpress!;
    await this.runWordPressDb(spec, log);
    await this.runWordPress(spec, log);
    await this.waitForWpDb(spec, log);
    if (!(await this.wp(spec, ["core", "is-installed"]).then(() => true, () => false))) {
      log("installing WordPress");
      // Credentials go through the environment, not argv (visible in `ps`).
      await this.docker(
        ["run", "--rm", "--user", "33:33", "--network", net, "--volumes-from", name, ...this.envArgs({ ...this.wpEnv(spec), WP_URL: "", WP_TITLE: "", WP_USER: "", WP_PASS: "", WP_EMAIL: "", WP_LOCALE: "" }),
          "wordpress:cli", "sh", "-c",
          'wp core install --url="$WP_URL" --title="$WP_TITLE" --admin_user="$WP_USER" --admin_password="$WP_PASS" --admin_email="$WP_EMAIL" --skip-email && { [ "$WP_LOCALE" = en_US ] || wp language core install "$WP_LOCALE" --activate || true; }'],
        log,
        { env: { ...this.wpEnv(spec), WP_URL: `https://${spec.domains[0]}`, WP_TITLE: wp.title, WP_USER: wp.adminUser, WP_PASS: wp.adminPassword, WP_EMAIL: wp.adminEmail, WP_LOCALE: wp.locale } },
      );
    }
    await this.syncSftp(spec, log);
    const version = (await this.wp(spec, ["core", "version"]).catch(() => "")).trim();
    return { runtime: { internalHost: name, dbName: "wordpress", dbUser: "wordpress", version, diskUsedMb: await this.diskUsedMb([`${name}-files`, `${name}-db`]) } };
  }

  async update(spec: WorkloadSpec, log: Log): Promise<JobResult> {
    const { name } = this.check(spec);
    if (spec.kind !== "database") await this.ensureProxy(log); // also upgrades an outdated proxy
    // Labels, env and limits are immutable on a container: re-create it. Data lives in volumes.
    if (spec.kind === "wordpress") {
      const before = (await this.wp(spec, ["option", "get", "home"]).catch(() => "")).trim();
      await this.runWordPress(spec, log);
      await this.syncSftp(spec, log);
      const home = `https://${spec.domains[0]}`;
      if (before && before !== home) {
        log(`primary domain changed: ${before} → ${home}`);
        await this.wp(spec, ["search-replace", before, home, "--all-tables", "--skip-columns=guid"], log);
      }
    } else if (spec.kind === "database") await this.runDatabase(spec, log);
    else await this.release(spec, log);
    return { runtime: { internalHost: name } };
  }

  async start(spec: WorkloadSpec, log: Log) {
    const { name } = this.check(spec);
    for (const c of [`${name}-db`, name, `${name}-cache`, `${name}-sftp`]) if (await this.exists("container", c)) await this.docker(["start", c], log);
    return {};
  }

  async stop(spec: WorkloadSpec, log: Log) {
    const { name } = this.check(spec);
    for (const c of [`${name}-sftp`, `${name}-cache`, name, `${name}-db`]) if (await this.exists("container", c)) await this.docker(["stop", c], log);
    return {};
  }

  async remove(spec: WorkloadSpec, log: Log) {
    const { name, net } = this.check(spec);
    log("removing containers, volumes, images and backups");
    for (const c of [`${name}-sftp`, `${name}-cache`, name, `${name}-db`]) await this.rmContainer(c);
    for (const v of [`${name}-files`, `${name}-db`, `${name}-data`, `${name}-site`, `${name}-cache`]) if (await this.exists("volume", v)) await this.docker(["volume", "rm", "-f", v]);
    if (await this.exists("network", net)) await this.docker(["network", "rm", net]).catch(() => {});
    await this.docker(["image", "rm", "-f", `${name}:current`], undefined, { quiet: true }).catch(() => {});
    await rm(path.join(this.opts.dataDir, "backups", spec.slug), { recursive: true, force: true });
    await rm(path.join(this.opts.dataDir, "builds", spec.slug), { recursive: true, force: true });
    await rm(path.join(this.opts.dataDir, "cache", spec.slug), { recursive: true, force: true });
    await rm(path.join(this.opts.dataDir, "sftp", spec.slug), { recursive: true, force: true });
    return {};
  }

  async clone(spec: WorkloadSpec, from: WorkloadSpec, log: Log): Promise<JobResult> {
    if (spec.kind !== "wordpress" || from.kind !== "wordpress") throw new Error("Only WordPress sites can be cloned");
    const target = this.check(spec);
    const source = this.check(from);
    await this.ensureNetwork(target.net);
    await this.ensureProxy(log);
    await this.runWordPressDb(spec, log);

    log(`copying files ${from.slug} → ${spec.slug}`);
    await this.rmContainer(target.name);
    await this.docker(["run", "--rm", "-v", `${source.name}-files:/from:ro`, "-v", `${target.name}-files:/to`, "alpine:3", "sh", "-c", "find /to -mindepth 1 -delete && cp -a /from/. /to/"], log);
    await this.runWordPress(spec, log); // entrypoint rewrites wp-config from the target's env
    await this.waitForWpDb(spec, log);

    log("copying database");
    const dump = await this.docker(["exec", "-e", "MYSQL_PWD", `${source.name}-db`, "mariadb-dump", "-uwordpress", "--single-transaction", "wordpress"], undefined, { env: { MYSQL_PWD: from.wordpress!.dbPassword }, quiet: true });
    await this.docker(["exec", "-i", "-e", "MYSQL_PWD", `${target.name}-db`, "mariadb", "-uwordpress", "wordpress"], undefined, { env: { MYSQL_PWD: spec.wordpress!.dbPassword }, input: dump, quiet: true });

    log(`rewriting URLs ${from.domains[0]} → ${spec.domains[0]}`);
    await this.wp(spec, ["search-replace", `https://${from.domains[0]}`, `https://${spec.domains[0]}`, "--all-tables", "--skip-columns=guid"], log);
    await this.wp(spec, ["cache", "flush"]).catch(() => {});
    return { runtime: { internalHost: target.name, dbName: "wordpress", dbUser: "wordpress" } };
  }

  // ─── Driver: Git deploys (apps and static sites) ─────────────────────────

  private async checkout(spec: WorkloadSpec, log: Log) {
    const src = spec.source!;
    const url = new URL(src.repoUrl);
    if (url.protocol !== "https:") throw new Error("Only https:// Git URLs are supported");
    if (!/^[\w./-]{1,200}$/.test(src.branch)) throw new Error("Invalid branch name");
    const dir = path.join(this.opts.dataDir, "builds", spec.slug);
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.dirname(dir), { recursive: true });
    log(`cloning ${url.host}${url.pathname} (${src.branch})`);
    // The token is supplied by a credential helper reading the environment, so
    // it is never written to .git/config nor visible in the process list.
    const auth = src.accessToken ? ["-c", "credential.helper=!f() { echo username=x-access-token; echo password=$ASTER_GIT_TOKEN; }; f"] : [];
    await this.exec("git", [...auth, "clone", "--depth", "1", "--branch", src.branch, url.toString(), dir], log, { env: { ASTER_GIT_TOKEN: src.accessToken ?? "", GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 10 * 60_000 });
    const [commitSha, ...message] = (await this.exec("git", ["-C", dir, "log", "-1", "--format=%H%n%s"], undefined, { quiet: true })).trim().split("\n");
    log(`HEAD is ${commitSha.slice(0, 7)} ${message.join(" ")}`);
    return { dir, commitSha, commitMessage: message.join(" ") };
  }

  /** (Re)starts the serving container of an app or static site from what is already built. */
  private async release(spec: WorkloadSpec, log: Log) {
    const { name, net, tenantNet } = this.check(spec);
    await this.ensureNetwork(net);
    await this.rmContainer(name);
    if (spec.kind === "static") {
      await this.docker(["run", "-d", "--name", name, "--network", net, ...this.limits(spec), "--read-only", "--tmpfs", "/var/cache/nginx", "--tmpfs", "/var/run", "-v", `${name}-site:/usr/share/nginx/html:ro`, ...this.route(spec, 80), "nginx:alpine"], log);
    } else {
      const port = spec.source?.port ?? 8080;
      const env = { ...spec.env, PORT: String(port) };
      await this.ensureNetwork(tenantNet);
      await this.docker(["run", "-d", "--name", name, "--network", net, ...this.limits(spec), ...this.envArgs(env), ...this.route(spec, port), `${name}:current`], log, { env });
      await this.docker(["network", "connect", tenantNet, name]); // reach the tenant's databases by name
    }
    await this.docker(["network", "connect", PROXY_NET, name]);
  }

  async deploy(spec: WorkloadSpec, log: Log): Promise<JobResult> {
    const { name } = this.check(spec);
    await this.ensureProxy(log);
    const { dir, commitSha, commitMessage } = await this.checkout(spec, log);
    const src = spec.source!;

    if (spec.kind === "static") {
      if (!REL_PATH.test(src.outputDir ?? "")) throw new Error("Invalid output directory");
      if (src.buildCommand) {
        log(`$ ${src.buildCommand}`);
        await this.docker(["run", "--rm", "--memory", "2g", "--cpus", "2", "--pids-limit", "1024", "-v", `${dir}:/src`, "-w", "/src", "-e", "BUILD_COMMAND", "-e", "CI=true", "node:22", "sh", "-c", "$BUILD_COMMAND"], log, { env: { BUILD_COMMAND: src.buildCommand }, timeoutMs: 20 * 60_000 });
      }
      log(`publishing ./${src.outputDir || ""}`);
      await this.docker(["run", "--rm", "-v", `${dir}:/src:ro`, "-v", `${name}-site:/site`, "-e", "OUT", "alpine:3", "sh", "-c", '[ -d "/src/$OUT" ] || { echo "output directory not found" >&2; exit 1; }; find /site -mindepth 1 -delete; cp -a "/src/$OUT/." /site/'], log, { env: { OUT: src.outputDir ?? "" } });
    } else {
      if (!(await stat(path.join(dir, "Dockerfile")).then(() => true, () => false))) throw new Error("No Dockerfile found in the repository root");
      log("building image");
      await this.docker(["build", "--memory", "2g", "-t", `${name}:build`, dir], log, { timeoutMs: 30 * 60_000 });
      await this.docker(["tag", `${name}:build`, `${name}:current`]);
    }
    await this.release(spec, log);
    await rm(dir, { recursive: true, force: true });
    log(`live at https://${spec.domains[0] ?? name}`);
    return { commitSha, commitMessage, runtime: { internalHost: name } };
  }

  // ─── Driver: logs & tools ────────────────────────────────────────────────

  async logs(spec: WorkloadSpec, lines: number) {
    const { name } = this.check(spec);
    // docker logs writes the container's stderr to stderr: capture both.
    const output = await new Promise<string>((resolve) =>
      execFile("docker", ["logs", "--tail", String(lines), "--timestamps", name], { maxBuffer: 16 * 1024 * 1024 }, (_err, out, errOut) => resolve(`${out}${errOut}`)),
    );
    return { output: output.slice(-200_000) };
  }

  async tool(spec: WorkloadSpec, tool: ToolName, args: Record<string, string>, log: Log): Promise<JobResult> {
    switch (tool) {
      case "cache.purge": {
        const cache = `aster-${spec.slug}-cache`;
        if (await this.exists("container", cache)) await this.docker(["exec", cache, "sh", "-c", "find /var/cache/nginx/site -type f -delete"], log);
        await this.wp(spec, ["cache", "flush"]).catch(() => {});
        return { output: "Cache cleared." };
      }
      case "wp.cache_flush":
        return { output: await this.wp(spec, ["cache", "flush"], log) };
      case "wp.debug_on":
      case "wp.debug_off":
        return { output: await this.wp(spec, ["config", "set", "WP_DEBUG", tool === "wp.debug_on" ? "true" : "false", "--raw"], log) };
      case "wp.inventory": {
        const list = async (kind: "plugin" | "theme") => {
          const rows = JSON.parse((await this.wp(spec, [kind, "list", "--format=json", "--fields=name,title,status,version,update_version"])) || "[]") as Record<string, string>[];
          return rows.map((p) => ({ name: p.name, title: p.title || p.name, status: p.status, version: p.version, update: p.update_version || "" }));
        };
        const inventory: WpInventory = { core: (await this.wp(spec, ["core", "version"])).trim(), plugins: await list("plugin"), themes: await list("theme") };
        return { output: JSON.stringify(inventory) };
      }
      case "wp.update": {
        const kind = args.kind === "theme" ? "theme" : args.kind === "core" ? "core" : "plugin";
        if (kind === "core") return { output: await this.wp(spec, ["core", "update"], log) };
        if (args.name && !/^[\w.-]{1,100}$/.test(args.name)) throw new Error("Invalid name");
        return { output: await this.wp(spec, [kind, "update", args.name || "--all"], log) };
      }
      case "wp.search_replace":
        if (!args.search || !args.replace) throw new Error("Both search and replace are required");
        // "--" ends option parsing: user text can never be read as a WP-CLI flag.
        return { output: await this.wp(spec, ["search-replace", "--all-tables", "--skip-columns=guid", "--", args.search, args.replace], log) };
      default:
        throw new Error(`Unknown tool ${String(tool)}`);
    }
  }

  // ─── Driver: request-level APM from the proxy's access log ───────────────

  async apm(spec: WorkloadSpec, minutes: number): Promise<JobResult> {
    this.check(spec);
    const file = path.join(this.accessLogDir, "access.log");
    const size = await stat(file).then((s) => s.size, () => 0);
    const router = `aster-${spec.slug}`;
    const since = Date.now() - minutes * 60_000;
    const durations: number[] = [];
    const status = { ok: 0, redirect: 0, clientError: 0, serverError: 0 };
    const byPath = new Map<string, { count: number; total: number; max: number }>();

    if (size) {
      // Only the tail can be inside the window; never load the whole log.
      const lines = createInterface({ input: createReadStream(file, { start: Math.max(0, size - 256 * 1024 * 1024) }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.includes(router)) continue;
        let entry: { RouterName?: string; RequestPath?: string; DownstreamStatus?: number; Duration?: number; StartUTC?: string };
        try {
          entry = JSON.parse(line);
        } catch {
          continue; // first line of the tail may be cut in half
        }
        if (!entry.RouterName?.startsWith(`${router}@`) && !entry.RouterName?.startsWith(`${router}-login@`)) continue;
        if (!entry.StartUTC || Date.parse(entry.StartUTC) < since) continue;
        const ms = (entry.Duration ?? 0) / 1e6; // Traefik logs nanoseconds
        durations.push(ms);
        const code = entry.DownstreamStatus ?? 0;
        if (code >= 500) status.serverError++;
        else if (code >= 400) status.clientError++;
        else if (code >= 300) status.redirect++;
        else status.ok++;
        const key = (entry.RequestPath ?? "/").split("?")[0].slice(0, 200);
        const row = byPath.get(key) ?? { count: 0, total: 0, max: 0 };
        row.count++;
        row.total += ms;
        row.max = Math.max(row.max, ms);
        if (byPath.size < 5000 || byPath.has(key)) byPath.set(key, row);
      }
      if (size > 1024 * 1024 * 1024) await truncate(file, 0).catch(() => {}); // crude rotation
    }

    durations.sort((a, b) => a - b);
    const rows = [...byPath].map(([p, r]) => ({ path: p, count: r.count, avgMs: Math.round(r.total / r.count), maxMs: Math.round(r.max) }));
    const report: ApmReport = {
      minutes,
      requests: durations.length,
      avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      p95Ms: durations.length ? Math.round(durations[Math.floor(durations.length * 0.95)] ?? durations.at(-1)!) : 0,
      status,
      slowest: rows.filter((r) => r.count >= 3).sort((a, b) => b.avgMs - a.avgMs).slice(0, 10),
      busiest: [...rows].sort((a, b) => b.count - a.count).slice(0, 10).map(({ path: p, count, avgMs }) => ({ path: p, count, avgMs })),
    };
    return { output: JSON.stringify(report) };
  }

  // ─── Driver: file manager ────────────────────────────────────────────────

  async files(spec: WorkloadSpec, action: JobPayloads["workload.files"]["action"], rel: string, content: string | undefined, log: Log): Promise<JobResult> {
    const { name } = this.check(spec);
    // The control plane already normalises paths; never trust that alone.
    if (rel.split("/").some((part) => part === ".." || part === ".") || rel.startsWith("/") || /[\0-\x1f]/.test(rel)) throw new Error("Invalid path");
    if (action !== "list" && !rel) throw new Error("Invalid path");

    // Runs as www-data in a throw-away container that sees nothing but the
    // site's files. The path arrives as $P: it is data, never part of the script.
    const run = (script: string, input?: string) =>
      this.docker(["run", "--rm", "-i", "--user", "33:33", "--network", "none", "--memory", "128m", "-v", `${name}-files:/site`, "-e", "P", "alpine:3", "sh", "-c", script], undefined, { env: { P: rel }, input, quiet: true, timeoutMs: 60_000 });

    if (action === "list") {
      const out = await run('cd "/site/$P" || exit 3; for f in * .[!.]*; do [ -e "$f" ] || [ -L "$f" ] || continue; stat -c "%F|%s|%Y|%n" -- "$f"; done').catch(() => {
        throw new Error("No such directory");
      });
      const entries = out.split("\n").filter(Boolean).slice(0, 2000).map((line) => {
        const [kind, size, mtime, ...rest] = line.split("|");
        return { name: rest.join("|"), type: kind === "directory" ? ("dir" as const) : kind === "symbolic link" ? ("link" as const) : ("file" as const), size: Number(size) || 0, mtime: Number(mtime) || 0 };
      });
      return { output: JSON.stringify({ kind: "list", path: rel, entries }) };
    }
    if (action === "read") {
      const LIMIT = 262_144;
      const out = await run(`[ -f "/site/$P" ] || exit 3; head -c ${LIMIT + 1} "/site/$P"`).catch(() => {
        throw new Error("No such file");
      });
      const binary = out.slice(0, 8000).includes("\u0000");
      return { output: JSON.stringify({ kind: "file", path: rel, content: binary ? "" : out.slice(0, LIMIT), truncated: out.length > LIMIT, binary }) };
    }
    log(`${action} ${rel}`);
    if (action === "write") await run('d=$(dirname "/site/$P"); [ -d "$d" ] || exit 3; cat > "/site/$P.aster-tmp" && mv "/site/$P.aster-tmp" "/site/$P"', content ?? "");
    else if (action === "mkdir") await run('mkdir -p "/site/$P"');
    else await run('[ -n "$P" ] && rm -rf -- "/site/$P"');
    return { output: JSON.stringify({ kind: "done", path: rel }) };
  }

  // ─── Driver: authoritative DNS (CoreDNS, file plugin) ────────────────────

  async dnsSync(data: JobPayloads["dns.sync"], log: Log): Promise<JobResult> {
    const dir = path.join(this.opts.dataDir, "dns");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const fqdn = (h: string) => `${h.toLowerCase().replace(/\.$/, "")}.`;
    const zones = data.zones.filter((z) => /^[a-z0-9.-]{1,253}$/.test(z.name));
    const ns = data.nameservers.filter((h) => /^[a-z0-9.-]{1,253}$/i.test(h)).map(fqdn);

    for (const zone of zones) {
      const primary = ns[0] ?? `ns1.${zone.name}.`;
      const hostmaster = fqdn((data.hostmaster || `hostmaster@${zone.name}`).replace("@", "."));
      const lines = [
        `$ORIGIN ${zone.name}.`,
        `@ 3600 IN SOA ${primary} ${hostmaster} ${zone.serial} 7200 3600 1209600 300`,
        ...ns.map((h) => `@ 3600 IN NS ${h}`),
        ...zone.records.map((r) => {
          const value =
            r.type === "TXT"
              ? (r.value.match(/[\s\S]{1,255}/g) ?? [""]).map((chunk) => `"${chunk.replace(/[\\"]/g, "\\$&").replace(/[\r\n]+/g, " ")}"`).join(" ")
              : r.type === "MX" || r.type === "SRV"
                ? `${r.priority} ${r.value}`
                : r.value;
          return `${r.name} ${r.ttl} IN ${r.type} ${value}`;
        }),
      ];
      await writeFile(path.join(dir, `db.${zone.name}`), `${lines.join("\n")}\n`);
    }
    await writeFile(
      path.join(dir, "Corefile"),
      `${zones.map((z) => `${z.name}:53 {\n  file /zones/db.${z.name}\n  errors\n}`).join("\n")}\n.:53 {\n  errors\n  health :8053\n}\n`,
    );

    log(`serving ${zones.length} zone(s) as ${ns.join(", ") || "(no name servers configured)"}`);
    await this.rmContainer("aster-dns");
    if (zones.length) {
      await this.docker(["run", "-d", "--name", "aster-dns", "--restart", "unless-stopped", "--memory", "128m", "-p", "53:53/udp", "-p", "53:53/tcp", "-v", `${dir}:/zones:ro`, "coredns/coredns:1.11.3", "-conf", "/zones/Corefile"], log);
    }
    return {};
  }

  // ─── Driver: database console ────────────────────────────────────────────

  async db(spec: WorkloadSpec, action: "tables" | "query", sql: string, log: Log): Promise<JobResult> {
    const target = this.dbCommand(spec, "restore"); // the interactive client of the engine
    if (!target) throw new Error("This engine has no SQL console");
    const postgres = spec.kind === "database" && spec.database!.engine === "postgres";
    const statement =
      action === "tables"
        ? postgres
          ? "select relname as \"table\", n_live_tup as rows, round(pg_total_relation_size(relid) / 1048576.0, 2) as size_mb from pg_stat_user_tables order by 1"
          : "select table_name as `table`, table_rows as `rows`, round((data_length + index_length) / 1048576, 2) as size_mb from information_schema.tables where table_schema = database() order by 1"
        : sql;
    if (action === "query") log(statement.slice(0, 300));

    // The statement goes through stdin: no quoting, no argv, no shell.
    const argv = postgres ? [...target.argv, "--csv", "-v", "ON_ERROR_STOP=1", "-P", "null=\\N"] : [...target.argv, "--batch", "--default-character-set=utf8mb4"];
    const out = await this.docker(["exec", "-i", ...this.envArgs(target.env), target.container, ...argv], undefined, { env: target.env, input: `${statement.replace(/;\s*$/, "")};\n`, quiet: true, timeoutMs: 30_000 });

    const LIMIT = 200;
    const lines = out.split("\n").filter((l) => l.length);
    if (!lines.length) return { output: JSON.stringify({ columns: [], rows: [], truncated: false, message: "Query OK" }) };
    const split = postgres ? parseCsvLine : (l: string) => l.split("\t");
    const [columns, ...rows] = lines.map(split);
    return {
      output: JSON.stringify({
        columns,
        rows: rows.slice(0, LIMIT).map((r) => r.map((c) => (c === "NULL" || c === "\\N" ? null : c.slice(0, 2000)))),
        truncated: rows.length > LIMIT,
      }),
    };
  }

  // ─── Driver: backups ─────────────────────────────────────────────────────

  private backupDir(spec: WorkloadSpec, backupId: string) {
    this.check(spec);
    if (!ID.test(backupId)) throw new Error("Invalid backup id");
    return path.join(this.opts.dataDir, "backups", spec.slug, backupId);
  }

  /** `docker exec` dump / restore command for the workload's database engine. */
  private dbCommand(spec: WorkloadSpec, mode: "dump" | "restore"): { container: string; env: Record<string, string>; argv: string[] } | null {
    const { name } = this.check(spec);
    if (spec.kind === "wordpress") {
      return { container: `${name}-db`, env: { MYSQL_PWD: spec.wordpress!.dbPassword }, argv: mode === "dump" ? ["mariadb-dump", "-uwordpress", "--single-transaction", "wordpress"] : ["mariadb", "-uwordpress", "wordpress"] };
    }
    const db = spec.database!;
    if (db.engine === "mysql") return { container: name, env: { MYSQL_PWD: db.password }, argv: mode === "dump" ? ["mariadb-dump", `-u${db.user}`, "--single-transaction", db.name] : ["mariadb", `-u${db.user}`, db.name] };
    if (db.engine === "postgres") return { container: name, env: { PGPASSWORD: db.password }, argv: mode === "dump" ? ["pg_dump", "-U", db.user, "--clean", "--if-exists", db.name] : ["psql", "-q", "-U", db.user, db.name] };
    return null; // redis: volume snapshot instead
  }

  private volumesToArchive(spec: WorkloadSpec) {
    const { name } = this.check(spec);
    if (spec.kind === "wordpress") return [`${name}-files`];
    if (spec.kind === "database" && spec.database!.engine === "redis") return [`${name}-data`];
    return [];
  }

  async backupCreate(spec: WorkloadSpec, backupId: string, log: Log) {
    const dir = this.backupDir(spec, backupId);
    await mkdir(dir, { recursive: true });
    const db = this.dbCommand(spec, "dump");
    if (db) {
      log("dumping database");
      // Stream straight to disk instead of through Node's memory.
      await this.exec("sh", ["-c", 'docker exec $ENVS "$C" "$@" | gzip > "$OUT"', "sh", ...db.argv], log, { env: { ...db.env, C: db.container, OUT: path.join(dir, "database.sql.gz"), ENVS: Object.keys(db.env).map((k) => `-e ${k}`).join(" ") } });
    }
    if (spec.kind === "database" && spec.database!.engine === "redis") await this.docker(["exec", "-e", "REDISCLI_AUTH", `aster-${spec.slug}`, "redis-cli", "SAVE"], log, { env: { REDISCLI_AUTH: spec.database!.password } });
    for (const volume of this.volumesToArchive(spec)) {
      log(`archiving ${volume}`);
      await this.docker(["run", "--rm", "-v", `${volume}:/data:ro`, "-v", `${dir}:/backup`, "alpine:3", "tar", "czf", `/backup/${volume}.tar.gz`, "-C", "/data", "."], log);
    }
    const out = await this.exec("du", ["-sk", dir], undefined, { quiet: true });
    return { sizeBytes: (parseInt(out, 10) || 0) * 1024 };
  }

  async backupRestore(spec: WorkloadSpec, backupId: string, log: Log) {
    const dir = this.backupDir(spec, backupId);
    if (!(await stat(dir).then(() => true, () => false))) throw new Error("Backup archive not found on this node");
    for (const volume of this.volumesToArchive(spec)) {
      log(`restoring ${volume}`);
      await this.docker(["run", "--rm", "-v", `${volume}:/data`, "-v", `${dir}:/backup:ro`, "alpine:3", "sh", "-c", `find /data -mindepth 1 -delete && tar xzf "/backup/${volume}.tar.gz" -C /data`], log);
    }
    const db = this.dbCommand(spec, "restore");
    if (db) {
      log("importing database");
      await this.exec("sh", ["-c", 'gunzip -c "$IN" | docker exec -i $ENVS "$C" "$@"', "sh", ...db.argv], log, { env: { ...db.env, C: db.container, IN: path.join(dir, "database.sql.gz"), ENVS: Object.keys(db.env).map((k) => `-e ${k}`).join(" ") } });
    }
    if (spec.kind === "database" && spec.database!.engine === "redis") await this.docker(["restart", `aster-${spec.slug}`], log);
    if (spec.kind === "wordpress") await this.wp(spec, ["cache", "flush"]).catch(() => {});
    return {};
  }

  async backupDelete(spec: WorkloadSpec, backupId: string) {
    await rm(this.backupDir(spec, backupId), { recursive: true, force: true });
    return {};
  }

  async workloadStats() {
    const out = await this.docker(["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}"], undefined, { quiet: true, timeoutMs: 20_000 });
    const mb = (v: string) => {
      const m = /([\d.]+)\s*([kKMGT]?)i?B/.exec(v);
      return m ? Number(m[1]) * ({ "": 1e-6, k: 1e-3, K: 1e-3, M: 1, G: 1e3, T: 1e6 }[m[2]] ?? 1) : 0;
    };
    const bySlug = new Map<string, { slug: string; cpuPercent: number; memMb: number; rxMb: number; txMb: number }>();
    for (const line of out.split("\n")) {
      const [name, cpu, mem, net] = line.split("|");
      const slug = /^aster-(.+?)(-db|-cache|-sftp)?$/.exec(name ?? "")?.[1];
      if (!slug || slug === "traefik" || slug === "dns" || !net) continue;
      const row = bySlug.get(slug) ?? { slug, cpuPercent: 0, memMb: 0, rxMb: 0, txMb: 0 };
      row.cpuPercent += parseFloat(cpu) || 0; // site + its database container
      row.memMb += mb(mem.split("/")[0]);
      if (!name.endsWith("-db")) [row.rxMb, row.txMb] = net.split("/").map(mb);
      bySlug.set(slug, row);
    }
    return [...bySlug.values()];
  }

  async workloadCount() {
    const out = await this.docker(["ps", "-a", "--filter", "name=^aster-", "--format", "{{.Names}}"], undefined, { quiet: true });
    return out.split("\n").filter((n) => n && n !== "aster-traefik" && n !== "aster-dns" && !/-(db|cache|sftp)$/.test(n)).length;
  }
}
