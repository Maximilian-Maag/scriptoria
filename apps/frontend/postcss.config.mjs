/**
 * Tailwind 4 is a PostCSS plugin and needs no configuration file of its own —
 * the design tokens live in `src/app/globals.css` next to the styles that use
 * them (NFR-12).
 */
export default {
  plugins: { "@tailwindcss/postcss": {} },
};
