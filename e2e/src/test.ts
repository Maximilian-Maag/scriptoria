/**
 * The suite's `test`, with one addition to Playwright's: the Next.js dev-tools
 * overlay is removed from the page before anything is asserted.
 *
 * That overlay is a *development server* artefact, not part of the product: a
 * floating indicator pinned to the bottom-left corner, which is exactly where
 * the navigation's "Sign out" lives. It intercepts the click, and the failure
 * reads as "the application will not let me sign out" — a report about the
 * framework's own debugging aid wearing the product's clothes.
 *
 * Hiding it here rather than clicking around it (`force: true`, or a coordinate
 * click) keeps every other interaction honest: a click that a real operator
 * could not make must fail, and only this one element is exempt from that rule.
 */
import { test as base, expect } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important; }";
      const attach = () => document.head?.append(style);
      if (document.head) attach();
      else document.addEventListener("DOMContentLoaded", attach, { once: true });
    });
    await use(page);
  },
});

export { expect };
