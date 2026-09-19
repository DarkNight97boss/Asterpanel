/**
 * Buildpacks: when a repository has no Dockerfile, recognise the stack from
 * its files and write one. Pure — the driver passes what it found on disk.
 * The app must listen on $PORT (also exported as the configured port).
 */

export type Buildpack = { name: string; dockerfile: string };

type Files = { has(path: string): boolean; read(path: string): string | undefined };

const json = (text: string | undefined): Record<string, unknown> => {
  try {
    return JSON.parse(text ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Major version from things like ">=20.1", "^22", "3.12.*"; falls back when absent or odd. */
const major = (spec: unknown, fallback: string, allowed: string[]) => {
  const m = /(\d{1,2})(?:\.(\d{1,2}))?/.exec(String(spec ?? ""));
  const v = m ? (allowed[0].includes(".") ? `${m[1]}.${m[2] ?? "0"}` : m[1]) : "";
  return allowed.includes(v) ? v : fallback;
};

const tail = (port: number, cmd: string) => `ENV PORT=${port}\nEXPOSE ${port}\nCMD ${cmd}\n`;
const sh = (command: string) => JSON.stringify(["sh", "-c", command]);

export function detectBuildpack(files: Files, port: number): Buildpack | null {
  if (files.has("package.json")) {
    const pkg = json(files.read("package.json"));
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const node = major((pkg.engines as Record<string, string> | undefined)?.node, "22", ["18", "20", "22", "24"]);
    const pm = files.has("pnpm-lock.yaml") ? "pnpm" : files.has("yarn.lock") ? "yarn" : files.has("bun.lockb") || files.has("bun.lock") ? "bun" : "npm";
    const install = { pnpm: "corepack enable && pnpm install --frozen-lockfile", yarn: "corepack enable && yarn install --immutable || yarn install --frozen-lockfile", bun: "npm i -g bun && bun install --frozen-lockfile", npm: files.has("package-lock.json") ? "npm ci" : "npm install" }[pm];
    const run = pm === "npm" ? "npm run" : `${pm} run`;
    // Manifests first: Docker re-uses the installed dependencies until they change, so most deploys skip the install.
    // Only when there are no install scripts that need the sources (postinstall hooks reading the repo).
    const lock = { pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: files.has("bun.lock") ? "bun.lock" : "bun.lockb", npm: "package-lock.json" }[pm];
    const hooks = ["preinstall", "install", "postinstall", "prepare"].some((h) => h in scripts);
    const manifests = !hooks && files.has(lock) ? `COPY package.json ${lock} ./\n` : "COPY . .\n";
    const start = scripts.start ? `${run} start` : typeof pkg.main === "string" && /^[\w./-]+$/.test(pkg.main) ? `node ${pkg.main}` : files.has("server.js") ? "node server.js" : files.has("index.js") ? "node index.js" : "";
    if (!start) return null;
    return {
      name: `Node.js ${node} (${pm})`,
      // Dev dependencies are needed by the build; production mode starts after it.
      dockerfile: `FROM node:${node}-slim\nWORKDIR /app\nENV CI=true\n${manifests}RUN ${install}\nCOPY . .\n${scripts.build ? `RUN ${run} build\n` : ""}ENV NODE_ENV=production\nRUN chown -R node:node /app\nUSER node\n${tail(port, sh(start))}`,
    };
  }

  if (files.has("requirements.txt") || files.has("pyproject.toml")) {
    const py = major(files.read(".python-version") ?? files.read("runtime.txt"), "3.12", ["3.10", "3.11", "3.12", "3.13"]);
    const deps = `${files.read("requirements.txt") ?? ""}\n${files.read("pyproject.toml") ?? ""}`.toLowerCase();
    const install = files.has("requirements.txt") ? "pip install --no-cache-dir -r requirements.txt" : "pip install --no-cache-dir .";
    const procfile = /^web:\s*(.+)$/m.exec(files.read("Procfile") ?? "")?.[1]?.trim();
    const start =
      procfile ||
      (files.has("manage.py") ? "python manage.py migrate --noinput && gunicorn --bind 0.0.0.0:$PORT $(ls */wsgi.py | head -n1 | sed 's#/wsgi.py##').wsgi" : "") ||
      (deps.includes("fastapi") || deps.includes("uvicorn") ? `uvicorn ${files.has("app/main.py") ? "app.main" : "main"}:app --host 0.0.0.0 --port $PORT` : "") ||
      (deps.includes("flask") || deps.includes("gunicorn") ? `gunicorn --bind 0.0.0.0:$PORT ${files.has("wsgi.py") ? "wsgi" : "app"}:app` : "") ||
      (files.has("main.py") ? "python main.py" : files.has("app.py") ? "python app.py" : "");
    if (!start) return null;
    const extra = /gunicorn/.test(start) && !deps.includes("gunicorn") ? " gunicorn" : /uvicorn/.test(start) && !deps.includes("uvicorn") ? " uvicorn" : "";
    const pip = extra ? ` && pip install --no-cache-dir${extra}` : "";
    // requirements.txt first: the dependency layer is re-used until it changes.
    const steps = files.has("requirements.txt") ? `COPY requirements.txt ./\nRUN ${install}${pip}\nCOPY . .` : `COPY . .\nRUN ${install}${pip}`;
    return { name: `Python ${py}`, dockerfile: `FROM python:${py}-slim\nWORKDIR /app\nENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1\n${steps}\nRUN useradd -m app && chown -R app /app\nUSER app\n${tail(port, sh(start))}` };
  }

  if (files.has("go.mod")) {
    const go = major(/^go\s+(\S+)/m.exec(files.read("go.mod") ?? "")?.[1], "1.23", ["1.21", "1.22", "1.23", "1.24", "1.25"]);
    return { name: `Go ${go}`, dockerfile: `FROM golang:${go} AS build\nWORKDIR /src\nCOPY . .\nRUN CGO_ENABLED=0 go build -o /out/app .\n\nFROM gcr.io/distroless/static-debian12:nonroot\nCOPY --from=build /out/app /app\n${tail(port, '["/app"]')}` };
  }

  if (files.has("composer.json") || files.has("index.php")) {
    const php = major(((json(files.read("composer.json")).require ?? {}) as Record<string, string>).php, "8.3", ["8.1", "8.2", "8.3", "8.4"]);
    const root = files.has("public/index.php") ? "/var/www/html/public" : "/var/www/html";
    const composer = files.has("composer.json") ? "COPY --from=composer:2 /usr/bin/composer /usr/bin/composer\nRUN apt-get update && apt-get install -y --no-install-recommends unzip git && rm -rf /var/lib/apt/lists/* && composer install --no-dev --optimize-autoloader --no-interaction\n" : "";
    return {
      name: `PHP ${php} (Apache)`,
      dockerfile: `FROM php:${php}-apache\nWORKDIR /var/www/html\nCOPY . .\n${composer}RUN a2enmod rewrite && sed -ri "s#/var/www/html#${root}#g" /etc/apache2/sites-available/*.conf && sed -ri "s/^Listen 80$/Listen ${port}/; s/:80>/:${port}>/" /etc/apache2/ports.conf /etc/apache2/sites-available/*.conf && chown -R www-data:www-data /var/www/html\n${tail(port, '["apache2-foreground"]')}`,
    };
  }

  if (files.has("Gemfile")) {
    const ruby = major(files.read(".ruby-version"), "3.3", ["3.1", "3.2", "3.3", "3.4"]);
    const start = /^web:\s*(.+)$/m.exec(files.read("Procfile") ?? "")?.[1]?.trim() || (files.has("config.ru") ? (files.has("bin/rails") ? "bin/rails server -b 0.0.0.0 -p $PORT" : "bundle exec rackup -o 0.0.0.0 -p $PORT") : "");
    if (!start) return null;
    return { name: `Ruby ${ruby}`, dockerfile: `FROM ruby:${ruby}-slim\nWORKDIR /app\nENV RAILS_ENV=production RACK_ENV=production BUNDLE_WITHOUT=development:test\nRUN apt-get update && apt-get install -y --no-install-recommends build-essential libpq-dev git && rm -rf /var/lib/apt/lists/*\nCOPY . .\nRUN bundle install\n${tail(port, sh(start))}` };
  }

  if (files.has("index.html")) {
    return { name: "Static files (nginx)", dockerfile: `FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nRUN sed -i "s/listen       80;/listen ${port};/" /etc/nginx/conf.d/default.conf\nEXPOSE ${port}\n` };
  }
  return null;
}
