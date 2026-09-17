/** @type {import("next").NextConfig} */
const config = {
  // The workspace packages ship TypeScript source rather than a build artefact,
  // so that a stale `dist` can never be what the three apps disagree over.
  transpilePackages: [
    "@scriptoria/contracts",
    "@scriptoria/core",
    "@scriptoria/config",
    "@scriptoria/db",
  ],

  // This app serves an API and a Swagger page. There is no product UI here —
  // that is the frontend's job, and the split is what keeps every privileged
  // operation on one side of a network boundary.
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,

  // ADR-007: the terminal WebSocket is mounted on the custom server, not on a
  // route handler. Nothing about it is Next.js's business.
  serverExternalPackages: ["ws", "ioredis", "postgres", "ldapts"],

  webpack: (config) => {
    // This app is ESM and its entrypoint is `server.ts`, run by Node through
    // tsx — so every relative import has to carry the `.js` specifier that
    // Node's ESM resolver requires. Next's bundler does not apply that mapping
    // on its own, and without this the route handlers cannot see the library
    // they and the custom server share.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default config;
