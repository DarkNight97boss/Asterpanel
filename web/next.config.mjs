/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output keeps the production Docker image small.
  output: "standalone",
  reactStrictMode: true,

  // Hardening of the *distributed* build. A deterrent only — the real protection
  // of the commercial layer is the signed-license gating
  // (control-plane/internal/licensing), not source obscurity. Here we just avoid
  // shipping readable source maps, a framework fingerprint header, and console
  // noise in the production bundle.
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
  compiler: {
    removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },
};

export default nextConfig;
