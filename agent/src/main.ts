import path from "node:path";
import { Agent, AGENT_VERSION, httpTransport, loadPublicKey } from "./agent";
import { DockerDriver } from "./docker";
import { SimulatedDriver } from "./simulated";

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    console.error(`Missing ${name}. See /etc/aster-agent.env`);
    process.exit(1);
  }
  return value;
};

const url = env("ASTER_URL");
const token = env("ASTER_TOKEN"); // "<nodeId>.<secret>"
const dataDir = path.resolve(env("ASTER_DATA_DIR", "/var/lib/aster-agent"));
const driverName = env("ASTER_DRIVER", "docker");

if (!url.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) {
  console.error("ASTER_URL must use https:// (plain http is only accepted for localhost)");
  process.exit(1);
}

const driver = driverName === "simulated" ? new SimulatedDriver(dataDir, Number(process.env.ASTER_SIM_DELAY_MS ?? 600)) : new DockerDriver({ dataDir, acmeEmail: process.env.ASTER_ACME_EMAIL ?? "" });

const agent = new Agent({
  nodeId: token.split(".")[0],
  publicKey: loadPublicKey(env("ASTER_PUBLIC_KEY")),
  driver,
  transport: httpTransport(url, token),
  dataDir,
  maxParallel: Number(process.env.ASTER_MAX_PARALLEL ?? 3),
  onError: (err) => console.error(new Date().toISOString(), err instanceof Error ? err.message : err),
});

console.log(`aster-agent ${AGENT_VERSION} · driver=${driver.name} · ${url}`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (agent.stop(), process.exit(0)));
void agent.run();
