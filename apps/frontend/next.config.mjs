/** @type {import("next").NextConfig} */
const config = {
  // The workspace packages ship TypeScript source rather than a build artefact,
  // so that a stale `dist` can never be what the three apps disagree over.
  transpilePackages: ["@scriptoria/contracts", "@scriptoria/core", "@scriptoria/config"],

  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
