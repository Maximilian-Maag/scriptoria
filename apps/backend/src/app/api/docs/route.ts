import { openApiHtml } from "@/lib/openapi/page";

/** The same contract, for a person. Rendered server-side; no assets, no CDN. */
export function GET(): Response {
  return new Response(openApiHtml(), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      // The page is generated from the document and contains no user input, but
      // it is still served from the control plane's own origin.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
