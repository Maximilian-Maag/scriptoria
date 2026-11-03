/** @type {import("next").NextConfig} */
const config = {
  // The workspace packages ship TypeScript source rather than a build artefact,
  // so that a stale `dist` can never be what the three apps disagree over.
  transpilePackages: ["@scriptoria/contracts", "@scriptoria/core", "@scriptoria/config"],

  /**
   * The development overlay mounts a portal in the bottom-left corner, which in
   * this layout sits exactly on top of the sign-out button and swallows clicks
   * meant for it. That is only ever a problem for something driving the page
   * rather than a person, so the e2e stack turns it off and nothing else does.
   */
  ...(process.env["DISABLE_DEV_INDICATORS"] === "true" ? { devIndicators: false } : {}),

  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
