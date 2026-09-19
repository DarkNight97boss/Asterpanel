import type { WorkloadType } from "@/db/schema";

/** Labels and routes per workload type, shared by client and admin screens. */
export const WORKLOAD_LABEL: Record<WorkloadType, { one: string; many: string; path: string; icon: string; blurb: string }> = {
  wordpress: { one: "WordPress site", many: "WordPress sites", path: "/client/sites", icon: "Ⓦ", blurb: "Managed WordPress with staging, backups and free SSL." },
  app: { one: "Application", many: "Applications", path: "/client/apps", icon: "▲", blurb: "Deploy any Dockerfile from Git, with env vars and logs." },
  database: { one: "Database", many: "Databases", path: "/client/databases", icon: "◉", blurb: "MySQL, PostgreSQL or Redis on your private network." },
  static: { one: "Static site", many: "Static sites", path: "/client/static-sites", icon: "◇", blurb: "Build from Git and serve with automatic HTTPS." },
};

export const TYPE_BY_PATH: Record<string, WorkloadType> = { sites: "wordpress", apps: "app", databases: "database", "static-sites": "static" };
