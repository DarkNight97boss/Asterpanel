import assert from "node:assert/strict";
import { test } from "node:test";
import { detectBuildpack } from "../agent/src/buildpack";

const repo = (files: Record<string, string>) => ({ has: (f: string) => f in files, read: (f: string) => files[f] });

test("buildpacks recognise the common stacks and honour versions, lockfiles and the port", () => {
  const next = detectBuildpack(repo({ "package.json": JSON.stringify({ engines: { node: ">=20.9" }, scripts: { build: "next build", start: "next start" } }), "pnpm-lock.yaml": "" }), 8080)!;
  assert.equal(next.name, "Node.js 20 (pnpm)");
  for (const line of ["FROM node:20-slim", "pnpm install --frozen-lockfile", "RUN pnpm run build", "USER node", "ENV PORT=8080", 'CMD ["sh","-c","pnpm run start"]']) assert.ok(next.dockerfile.includes(line), line);

  const plain = detectBuildpack(repo({ "package.json": JSON.stringify({ main: "src/server.js", engines: { node: "7" } }), "package-lock.json": "" }), 3000)!;
  assert.ok(plain.dockerfile.includes("FROM node:22-slim") && plain.dockerfile.includes("npm ci") && plain.dockerfile.includes("node src/server.js") && !plain.dockerfile.includes("run build"));
  assert.equal(detectBuildpack(repo({ "package.json": JSON.stringify({ main: "x.js; rm -rf /" }) }), 3000), null, "nothing to start, and nothing unsafe is ever copied into a command");

  const api = detectBuildpack(repo({ "requirements.txt": "fastapi==0.115\n", "app/main.py": "", ".python-version": "3.11.9" }), 8000)!;
  assert.equal(api.name, "Python 3.11");
  assert.ok(api.dockerfile.includes("uvicorn app.main:app --host 0.0.0.0 --port $PORT") && api.dockerfile.includes("pip install --no-cache-dir uvicorn") && api.dockerfile.includes("USER app"));
  assert.ok(detectBuildpack(repo({ "requirements.txt": "flask\n", Procfile: "web: gunicorn site:app\nworker: x" }), 5000)!.dockerfile.includes("gunicorn site:app"));

  const go = detectBuildpack(repo({ "go.mod": "module x\n\ngo 1.22.3\n" }), 9000)!;
  assert.ok(go.name === "Go 1.22" && go.dockerfile.includes("distroless") && go.dockerfile.includes("EXPOSE 9000"));
  const php = detectBuildpack(repo({ "composer.json": JSON.stringify({ require: { php: "^8.2" } }), "public/index.php": "" }), 8080)!;
  assert.ok(php.name === "PHP 8.2 (Apache)" && php.dockerfile.includes("/var/www/html/public") && php.dockerfile.includes("Listen 8080"));
  assert.equal(detectBuildpack(repo({ "index.html": "" }), 80)!.name, "Static files (nginx)");
  assert.equal(detectBuildpack(repo({ "README.md": "" }), 3000), null);
});
