import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { JobPayloads, JobResult, MigrationSource, OffsiteTarget, WorkloadSpec } from "../../src/platform/protocol";
import { cronMatches, parseCron } from "../../src/platform/cron";
import type { Driver, Log } from "./driver";

type State = { offsite?: Record<string, number>; workloads: Record<string, { crons?: { schedule: string; command: string }[]; kind: string; running: boolean; domains: string[]; updated?: string[]; net?: number; files?: Record<string, string> }>; backups: Record<string, number> };

/**
 * Pretends to be a container host. State lives in a JSON file so restarts of
 * the agent behave like a real node. Used for local development, demos and
 * the test-suite — never for customers.
 */
export class SimulatedDriver implements Driver {
  readonly name = "simulated";
  private file: string;

  constructor(dataDir: string, private delayMs = 400) {
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "simulated-state.json");
  }

  private read(): State {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as State) : { workloads: {}, backups: {} };
  }
  private write(mutate: (s: State) => void) {
    const s = this.read();
    mutate(s);
    writeFileSync(this.file, JSON.stringify(s, null, 2));
  }
  private async step(log: Log, line: string) {
    log(line);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
  }
  private runtime(spec: WorkloadSpec): JobResult {
    return {
      runtime: {
        internalHost: `aster-${spec.slug}`,
        dbName: spec.database?.name ?? (spec.kind === "wordpress" ? "wordpress" : undefined),
        dbUser: spec.database?.user ?? (spec.kind === "wordpress" ? "wordpress" : undefined),
        diskUsedMb: 80 + Math.round(Math.random() * 400),
        version: spec.kind === "wordpress" ? "6.8" : spec.database?.version,
      },
    };
  }
  private must(spec: WorkloadSpec) {
    if (!this.read().workloads[spec.slug]) throw new Error(`Workload ${spec.slug} does not exist on this node`);
  }

  async create(spec: WorkloadSpec, log: Log) {
    await this.step(log, `[sim] creating network aster-${spec.slug} (tenant ${spec.tenant})`);
    if (spec.kind === "wordpress") {
      await this.step(log, "[sim] starting mariadb:11");
      await this.step(log, `[sim] starting wordpress:php${spec.wordpress!.phpVersion}-apache (${spec.resources.memoryMb} MB, ${spec.resources.cpus} CPU)`);
      await this.step(log, `[sim] wp core install --url=https://${spec.domains[0]} --admin_user=${spec.wordpress!.adminUser}`);
    } else if (spec.kind === "database") {
      await this.step(log, `[sim] starting ${spec.database!.engine}:${spec.database!.version || "latest"}`);
    } else {
      this.write((s) => (s.workloads[spec.slug] = { kind: spec.kind, running: false, domains: spec.domains }));
      return this.deploy(spec, log);
    }
    await this.step(log, `[sim] routing ${spec.domains.join(", ") || "(no public hostname)"} with automatic TLS`);
    this.write((s) => (s.workloads[spec.slug] = { kind: spec.kind, running: true, domains: spec.domains }));
    return this.runtime(spec);
  }

  async update(spec: WorkloadSpec, log: Log) {
    this.must(spec);
    await this.step(log, `[sim] re-creating container with the new configuration`);
    await this.step(log, spec.cache?.enabled ? `[sim] edge cache on: TTL ${spec.cache.ttlMinutes} min, ${spec.cache.bypass.length} excluded path(s)` : "[sim] edge cache off");
    if (spec.bots) await this.step(log, `[sim] bot protection: bad bots ${spec.bots.blockBad ? "blocked" : "allowed"}, AI crawlers ${spec.bots.blockAi ? "blocked" : "allowed"}, ${spec.bots.ratePerMinute || "no"} req/min per IP, login ${spec.bots.protectLogin ? "protected" : "open"}`);
    if (spec.cdn?.enabled) await this.step(log, `[sim] static assets cached ${spec.cdn.maxAgeDays} day(s), compression on`);
    await this.step(log, spec.sftp?.enabled ? `[sim] SFTP enabled on port ${spec.sftp.port} for user ${spec.sftp.username}, ${spec.sftp.keys?.length ?? 0} SSH key(s)` : "[sim] SFTP disabled");
    if (spec.redirects?.length) await this.step(log, `[sim] ${spec.redirects.length} redirect rule(s): ${spec.redirects.map((r) => `${r.from} → ${r.to} (${r.code})`).join(", ")}`);
    if (spec.denyIps?.length) await this.step(log, `[sim] denying ${spec.denyIps.length} address(es): ${spec.denyIps.join(", ")}`);
    await this.step(log, `[sim] routing ${spec.domains.join(", ")}`);
    if (spec.wordpress?.php) await this.step(log, `[sim] php.ini: memory ${spec.wordpress.php.memoryLimitMb}M, uploads ${spec.wordpress.php.uploadMaxMb}M, ${spec.wordpress.php.maxExecutionTime}s, ${spec.wordpress.php.maxInputVars} input vars`);
    if (spec.kind === "wordpress") await this.step(log, spec.wordpress?.objectCache ? "[sim] Redis object cache on" : "[sim] Redis object cache off");
    if (spec.edge) await this.step(log, `[sim] edge: HSTS ${spec.edge.hsts ? "on" : "off"}, site password ${spec.edge.basicAuth ? `for ${spec.edge.basicAuth.user}` : "off"}`);
    if (spec.crons?.length) await this.step(log, `[sim] ${spec.crons.length} scheduled job(s)`);
    this.write((s) => {
      s.workloads[spec.slug].domains = spec.domains;
      s.workloads[spec.slug].crons = spec.crons ?? [];
    });
    return this.runtime(spec);
  }

  async start(spec: WorkloadSpec, log: Log) {
    this.must(spec);
    await this.step(log, "[sim] starting containers");
    this.write((s) => (s.workloads[spec.slug].running = true));
    return {};
  }

  async stop(spec: WorkloadSpec, log: Log) {
    if (!this.read().workloads[spec.slug]) return {}; // stopping nothing is fine
    await this.step(log, "[sim] stopping containers");
    this.write((s) => (s.workloads[spec.slug].running = false));
    return {};
  }

  async remove(spec: WorkloadSpec, log: Log) {
    await this.step(log, "[sim] removing containers, volumes, network and backups");
    this.write((s) => {
      delete s.workloads[spec.slug];
      for (const key of Object.keys(s.backups)) if (key.startsWith(`${spec.slug}/`)) delete s.backups[key];
    });
    return {};
  }

  async clone(spec: WorkloadSpec, from: WorkloadSpec, log: Log) {
    this.must(from);
    await this.step(log, `[sim] copying files ${from.slug} → ${spec.slug}`);
    await this.step(log, `[sim] copying database ${from.slug} → ${spec.slug}`);
    await this.step(log, `[sim] wp search-replace ${from.domains[0]} ${spec.domains[0]}`);
    this.write((s) => (s.workloads[spec.slug] = { kind: spec.kind, running: true, domains: spec.domains }));
    return this.runtime(spec);
  }

  async deploy(spec: WorkloadSpec, log: Log, ids?: { deploymentId: string; rollbackTo?: string; keepImages?: string[] }) {
    this.must(spec);
    const src = spec.source!;
    if (ids?.rollbackTo) {
      await this.step(log, `[sim] re-tagging image d-${ids.rollbackTo.slice(0, 8)} as current`);
      await this.step(log, "[sim] new container healthy, switching traffic");
      return this.runtime(spec);
    }
    if (/fail/i.test(src.branch)) {
      await this.step(log, `[sim] git clone --branch ${src.branch} ${src.repoUrl}`);
      throw new Error(`Remote branch ${src.branch} not found`);
    }
    const sha = randomBytes(20).toString("hex");
    await this.step(log, `[sim] git clone --depth 1 --branch ${src.branch} ${src.repoUrl}`);
    await this.step(log, `[sim] HEAD is now at ${sha.slice(0, 7)}`);
    if (spec.kind === "static") {
      if (src.buildCommand) await this.step(log, `[sim] $ ${src.buildCommand}`);
      await this.step(log, `[sim] publishing ./${src.outputDir || "."}`);
    } else {
      await this.step(log, "[sim] docker build . (Dockerfile)");
      if (/unhealthy/i.test(src.branch)) throw new Error("The new version did not answer on its port within 90 seconds; the previous version keeps serving");
      await this.step(log, `[sim] starting container on port ${src.port ?? 8080} with ${Object.keys(spec.env ?? {}).length} env vars`);
    }
    await this.step(log, `[sim] live at https://${spec.domains[0]}`);
    this.write((s) => (s.workloads[spec.slug].running = true));
    return { ...this.runtime(spec), commitSha: sha, commitMessage: "Simulated commit" };
  }

  async logs(spec: WorkloadSpec, lines: number) {
    this.must(spec);
    const now = Date.now();
    const sample = ['"GET / HTTP/1.1" 200 5123', '"GET /wp-login.php HTTP/1.1" 200 2871', '"POST /wp-cron.php HTTP/1.1" 200 0', '"GET /favicon.ico HTTP/1.1" 404 196'];
    const output = Array.from({ length: Math.min(lines, 25) }, (_, i) => `${new Date(now - (25 - i) * 61_000).toISOString()} ${spec.domains[0] ?? spec.slug} ${sample[i % sample.length]}`).join("\n");
    return { output };
  }

  async tool(spec: WorkloadSpec, tool: string, args: Record<string, string>, log: Log) {
    this.must(spec);
    if (tool === "cache.purge") {
      await this.step(log, "[sim] purging edge cache");
      return { output: "Cache cleared." };
    }
    if (tool === "wp.scan") {
      await this.step(log, "[sim] verifying core and plugin checksums, scanning files");
      // A site named "infected…" stands in for a compromised one.
      const hit = /infected/i.test(spec.slug);
      return { output: JSON.stringify({ scan: { core: hit ? ["File doesn't verify against checksum: wp-includes/load.php"] : [], plugins: [], uploadsPhp: hit ? ["wp-content/uploads/2026/09/x.php"] : [], suspicious: hit ? ["wp-content/uploads/2026/09/x.php"] : [], truncated: false } }) };
    }
    if (tool === "wp.login") {
      await this.step(log, "[sim] creating a one-time login link");
      return { output: JSON.stringify({ url: `https://${spec.domains[0]}/?aster_login=${randomBytes(32).toString("hex")}` }) };
    }
    if (tool === "wp.autoupdate") {
      await this.step(log, `[sim] wp core/plugin/theme update (${args.scope === "all" ? "all" : "minor"})`);
      // A site named "fragile…" stands in for an update that breaks the home page.
      if (/fragile/i.test(spec.slug)) throw new Error("SITE_UNHEALTHY after the update: HTTP 500");
      this.write((s) => (s.workloads[spec.slug].updated = ["akismet", "twentytwentyfive"]));
      return { output: "Success: Updated 2 of 2 plugins." };
    }
    if (tool === "wp.inventory") {
      const done = new Set(this.read().workloads[spec.slug].updated ?? []);
      const item = (name: string, title: string, status: string, version: string, update: string) => ({ name, title, status, version: done.has(name) ? update || version : version, update: done.has(name) ? "" : update });
      return {
        output: JSON.stringify({
          core: done.has("core") ? "6.8.2" : "6.8",
          plugins: [item("akismet", "Akismet Anti-spam", "active", "5.3", "5.4"), item("woocommerce", "WooCommerce", "active", "9.1.2", "9.3.0"), item("wordpress-seo", "Yoast SEO", "active", "23.4", ""), item("hello", "Hello Dolly", "inactive", "1.7.2", "")],
          themes: [item("twentytwentyfive", "Twenty Twenty-Five", "active", "1.0", "1.2"), item("twentytwentyfour", "Twenty Twenty-Four", "inactive", "1.3", "")],
        }),
      };
    }
    if (tool === "wp.update") {
      await this.step(log, `[sim] wp ${args.kind ?? "plugin"} update ${args.name || "--all"}`);
      const names = args.kind === "core" ? ["core"] : args.name ? [args.name] : args.kind === "theme" ? ["twentytwentyfive"] : ["akismet", "woocommerce"];
      this.write((s) => (s.workloads[spec.slug].updated = [...new Set([...(s.workloads[spec.slug].updated ?? []), ...names])]));
      return { output: `Success: Updated ${names.length} item(s).` };
    }
    await this.step(log, `[sim] ${tool} ${Object.entries(args).map(([k, v]) => `${k}=${v}`).join(" ")}`.trim());
    return { output: tool === "wp.search_replace" ? "Success: Made 42 replacements." : "Success." };
  }

  async apm(spec: WorkloadSpec, minutes: number) {
    this.must(spec);
    const scale = minutes / 15;
    const paths: [string, number, number, number][] = [["/", 410, 182, 940], ["/shop/", 233, 346, 2210], ["/wp-admin/admin-ajax.php", 198, 512, 4380], ["/checkout/", 41, 1284, 6120], ["/blog/hello-world/", 120, 164, 610], ["/wp-json/wp/v2/posts", 67, 233, 1490], ["/wp-login.php", 38, 121, 380]];
    const rows = paths.map(([path, count, avgMs, maxMs]) => ({ path, count: Math.round(count * scale), avgMs, maxMs }));
    const requests = rows.reduce((n, r) => n + r.count, 0);
    return {
      output: JSON.stringify({
        minutes,
        requests,
        avgMs: Math.round(rows.reduce((n, r) => n + r.avgMs * r.count, 0) / requests),
        p95Ms: 1840,
        status: { ok: Math.round(requests * 0.93), redirect: Math.round(requests * 0.04), clientError: Math.round(requests * 0.025), serverError: Math.round(requests * 0.005) },
        slowest: [...rows].sort((a, b) => b.avgMs - a.avgMs).slice(0, 10),
        busiest: [...rows].sort((a, b) => b.count - a.count).slice(0, 10).map(({ path, count, avgMs }) => ({ path, count, avgMs })),
      }),
    };
  }

  /** A tiny in-memory WordPress tree; edits persist in the state file. */
  async files(spec: WorkloadSpec, action: JobPayloads["workload.files"]["action"], path: string, content: string | undefined, log: Log, encoding: "utf8" | "base64" = "utf8") {
    this.must(spec);
    if (encoding === "base64") content = `[uploaded file, ${Buffer.from(content ?? "", "base64").length} bytes]`;
    const seed: Record<string, string> = {
      "index.php": "<?php\n// Front to the WordPress application.\ndefine( 'WP_USE_THEMES', true );\nrequire __DIR__ . '/wp-blog-header.php';\n",
      "wp-config.php": "<?php\ndefine( 'DB_NAME', 'wordpress' );\ndefine( 'WP_DEBUG', false );\n",
      ".htaccess": "# BEGIN WordPress\nRewriteEngine On\n# END WordPress\n",
      "wp-content/themes/twentytwentyfive/style.css": "/* Theme Name: Twenty Twenty-Five */\n",
      "wp-content/plugins/akismet/akismet.php": "<?php // Akismet\n",
      "wp-content/uploads/2026/09/.keep": "",
      "wp-admin/index.php": "<?php // Dashboard\n",
      "wp-includes/version.php": "<?php $wp_version = '6.8';\n",
    };
    const tree = Object.fromEntries(Object.entries({ ...seed, ...(this.read().workloads[spec.slug].files ?? {}) }).filter(([, v]) => v !== "\u0000deleted"));
    const save = (mutate: (files: Record<string, string>) => void) => this.write((s) => { const f = { ...seed, ...(s.workloads[spec.slug].files ?? {}) }; mutate(f); s.workloads[spec.slug].files = f; });
    const prefix = path ? `${path}/` : "";

    if (action === "list") {
      const names = new Map<string, { name: string; type: "dir" | "file"; size: number; mtime: number }>();
      for (const [file, body] of Object.entries(tree)) {
        if (!file.startsWith(prefix)) continue;
        const [head, ...rest] = file.slice(prefix.length).split("/");
        if (head === ".keep") continue;
        names.set(head, { name: head, type: rest.length ? "dir" : "file", size: rest.length ? 4096 : body.length, mtime: 1_758_275_462 });
      }
      if (path && !names.size && !Object.keys(tree).some((f) => f.startsWith(prefix))) throw new Error("No such directory");
      return { output: JSON.stringify({ kind: "list", path, entries: [...names.values()] }) };
    }
    if (action === "read") {
      if (!(path in tree)) throw new Error("No such file");
      return { output: JSON.stringify({ kind: "file", path, content: tree[path], truncated: false, binary: false }) };
    }
    await this.step(log, `[sim] ${action} ${path}`);
    if (action === "write") save((f) => (f[path] = content ?? ""));
    if (action === "mkdir") save((f) => (f[`${path}/.keep`] = ""));
    if (action === "delete") save((f) => { for (const k of Object.keys(f)) if (k === path || k.startsWith(`${path}/`)) f[k] = "\u0000deleted"; });
    return { output: JSON.stringify({ kind: "done", path }) };
  }

  async dnsSync(data: JobPayloads["dns.sync"], log: Log) {
    const records = data.zones.reduce((n, z) => n + z.records.length, 0);
    await this.step(log, `[sim] coredns: ${data.zones.length} zone(s), ${records} record(s), NS ${data.nameservers.join(", ") || "(not configured)"}`);
    for (const z of data.zones) log(`[sim]   ${z.name} serial ${z.serial}`);
    return {};
  }

  async db(spec: WorkloadSpec, action: "tables" | "query", sql: string, log: Log) {
    this.must(spec);
    if (action === "tables") {
      const names = spec.kind === "wordpress" ? ["wp_commentmeta", "wp_comments", "wp_options", "wp_postmeta", "wp_posts", "wp_terms", "wp_usermeta", "wp_users"] : ["customers", "orders", "order_items"];
      return { output: JSON.stringify({ columns: ["table", "rows", "size_mb"], rows: names.map((n, i) => [n, String((i + 1) * 137), (0.2 + i * 0.35).toFixed(2)]), truncated: false }) };
    }
    await this.step(log, `[sim] ${sql.slice(0, 120)}`);
    if (/\bsyntax_error\b/i.test(sql)) throw new Error("You have an error in your SQL syntax near 'syntax_error'");
    if (!/^\s*(select|show|with|explain|describe|desc)\b/i.test(sql)) return { output: JSON.stringify({ columns: [], rows: [], truncated: false, message: "Query OK, 1 row affected" }) };
    return { output: JSON.stringify({ columns: ["ID", "post_title", "post_status", "post_date"], rows: [["1", "Hello world!", "publish", "2026-09-19 10:51:02"], ["2", "Sample Page", "publish", "2026-09-19 10:51:02"], ["3", "Privacy Policy", "draft", null]], truncated: false }) };
  }

  async migrate(spec: WorkloadSpec, source: MigrationSource, newUrl: string, log: Log) {
    this.must(spec);
    const from = source.type === "archive" ? new URL(source.url).hostname : `${source.user}@${source.host}:${source.path}`;
    await this.step(log, source.type === "archive" ? `[sim] downloading archive from ${from}` : `[sim] copying files from ${from}`);
    // Hosts starting with "fail" stand in for wrong passwords and broken archives.
    if (from.startsWith("fail") || from.includes("@fail")) throw new Error(source.type === "ssh" ? "Permission denied (password)" : "The archive contains no WordPress installation");
    await this.step(log, "[sim] importing database (wpx_ tables)");
    await this.step(log, `[sim] replacing https://old-site.example with ${newUrl}`);
    this.write((s) => (s.workloads[spec.slug].files = { ...s.workloads[spec.slug].files, "wp-content/migrated.txt": from }));
    return { runtime: { version: "6.7" }, output: JSON.stringify({ oldUrl: "https://old-site.example", tablePrefix: "wpx_", wpVersion: "6.7" }) };
  }

  async runDueCrons(now: Date) {
    const started: string[] = [];
    for (const [slug, w] of Object.entries(this.read().workloads)) {
      if (!w.running) continue;
      for (const job of w.crons ?? []) {
        const schedule = parseCron(job.schedule);
        if (schedule && cronMatches(schedule, now)) started.push(`${slug}: ${job.command}`);
      }
    }
    return started;
  }

  async backupCreate(spec: WorkloadSpec, backupId: string, log: Log, offsite?: OffsiteTarget) {
    this.must(spec);
    await this.step(log, "[sim] dumping database");
    await this.step(log, "[sim] archiving files");
    const sizeBytes = 20_000_000 + Math.round(Math.random() * 80_000_000);
    this.write((s) => (s.backups[`${spec.slug}/${backupId}`] = sizeBytes));
    if (!offsite) return { sizeBytes };
    await this.step(log, `[sim] uploading to ${this.remote(offsite, spec, backupId)}`);
    // A bucket named "fail…" stands in for wrong keys or an unreachable endpoint.
    if (offsite.bucket.startsWith("fail")) return { sizeBytes, offsite: "failed" as const, offsiteError: "AccessDenied: simulated upload failure" };
    this.write((s) => {
      (s.offsite ??= {})[`${spec.slug}/${backupId}`] = sizeBytes;
      if (!offsite.keepLocal) delete s.backups[`${spec.slug}/${backupId}`];
    });
    return { sizeBytes, offsite: "uploaded" as const };
  }

  private remote = (o: OffsiteTarget, spec: WorkloadSpec, backupId: string) => `s3://${o.bucket}/${[o.prefix, spec.slug, backupId].filter(Boolean).join("/")}`;

  async offsiteTest(offsite: OffsiteTarget, log: Log) {
    await this.step(log, `[sim] writing, reading and deleting a probe object in s3://${offsite.bucket}`);
    if (offsite.bucket.startsWith("fail")) throw new Error("AccessDenied: simulated failure");
    return { output: "ok" };
  }

  async backupRestore(spec: WorkloadSpec, backupId: string, log: Log, offsite?: OffsiteTarget) {
    const key = `${spec.slug}/${backupId}`;
    if (!this.read().backups[key]) {
      const remote = offsite && this.read().offsite?.[key];
      if (!remote) throw new Error("Backup archive not found on this node");
      await this.step(log, `[sim] downloading from ${this.remote(offsite, spec, backupId)}`);
      this.write((s) => (s.backups[key] = remote));
    }
    await this.step(log, "[sim] restoring files");
    await this.step(log, "[sim] importing database");
    return {};
  }

  async backupDelete(spec: WorkloadSpec, backupId: string, log: Log, offsite?: OffsiteTarget) {
    await this.step(log, "[sim] deleting archive");
    if (offsite) await this.step(log, `[sim] deleting ${this.remote(offsite, spec, backupId)}`);
    this.write((s) => {
      delete s.backups[`${spec.slug}/${backupId}`];
      if (offsite) delete s.offsite?.[`${spec.slug}/${backupId}`];
    });
    return {};
  }

  async workloadStats() {
    const state = this.read();
    const hour = new Date().getHours() + new Date().getMinutes() / 60;
    const day = 0.55 + 0.45 * Math.sin(((hour - 9) / 24) * 2 * Math.PI); // busier in the afternoon
    const out = Object.entries(state.workloads).filter(([, w]) => w.running).map(([slug, w]) => {
      w.net = (w.net ?? 40) + Math.round(3 + 25 * day * Math.random());
      const heavy = w.kind === "wordpress" ? 1 : w.kind === "static" ? 0.15 : 0.6;
      return { slug, cpuPercent: Math.round((4 + 38 * day * Math.random()) * heavy), memMb: Math.round((140 + 220 * day + 40 * Math.random()) * heavy), rxMb: Math.round(w.net * 0.35), txMb: w.net };
    });
    writeFileSync(this.file, JSON.stringify(state, null, 2));
    return out;
  }

  async workloadCount() {
    return Object.keys(this.read().workloads).length;
  }
}
