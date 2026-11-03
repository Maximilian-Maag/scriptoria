import { openApiDocument } from "@/lib/openapi/document";

/**
 * The machine-readable contract. Unauthenticated on purpose: it describes the
 * API rather than answering with anything from it, and an integrator needs it
 * before they have credentials. Nothing in it is a secret — the paths and their
 * guards are exactly what a reader can infer by trying them.
 */
export function GET(): Response {
  return Response.json(openApiDocument(), {
    headers: { "cache-control": "public, max-age=300" },
  });
}
