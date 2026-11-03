# ADR-009 — The REST contract is generated from the schemas, and its page ships no renderer

**Status:** Accepted
**Context:** ADR-002, NFR-01, NFR-11

## Context

The platform needs a published REST contract: something an integrator can read, and something a
client can be generated from. ADR-002 already argues that `packages/contracts` is the single
definition the frontend, the backend and the runner share — the OpenAPI document is named there
as one of the things that definition buys.

## Decision

The document is generated at runtime from the Zod schemas the routes already validate with, and
served at `/api/openapi.json`. A second route, `/api/docs`, renders the same document into one
self-contained HTML page, server-side, with no client-side renderer of any kind.

Both are unauthenticated. What is *not* generated — which routes need a session, which need
root, and what each one is for — sits beside each path in `lib/openapi/document.ts` and is the
only part of that file worth reviewing by hand.

## Why not write the document by hand

A hand-written document is a second definition of the same thing, and a second definition
drifts. It is wrong the first time a field is added, and nobody finds out until an integrator
builds against it. Generating it means a field that does not exist in `@scriptoria/contracts`
cannot appear in the published contract, because there is nowhere for it to come from.

The half that *is* hand-written is guarded differently: a test walks the App Router directory
and compares the paths and methods it finds against the document, in both directions. A route
added without a `registerPath` beside it fails the build.

## Why not Swagger UI

NFR-01 puts this platform in a private network with no route out. A documentation page that
fetches its own renderer from a CDN is a blank page in exactly the environment the product runs
in — and the failure is silent, because the page still loads. Vendoring the dist bundle avoids
that but buys an asset-copying build step, kept working forever, for a document of thirty
endpoints.

Rendering it server-side costs one file and produces a page that is HTML and nothing else: no
script, no font, no second request. It is less capable than Swagger UI and deliberately so —
anything more exact is in `/api/openapi.json`, which is the artefact to generate a client from.

## Consequences

- The page is a reading surface, not a console: there is no "try it out" button, and adding one
  would mean shipping a renderer after all.
- The document describes no WebSocket. OpenAPI describes requests and responses, and the
  terminal is a byte stream held open for the life of a run (ADR-007); its frames are specified
  in `packages/contracts/src/stream.ts` and drawn in the model instead.
- The generator mistypes one thing — a coerced number with a minimum of zero comes out
  nullable — and that is corrected at the two call sites rather than passed on to every client
  generated from the document. A generator upgrade should check whether the correction is still
  needed.
