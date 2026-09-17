import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openApiDocument } from "@/lib/openapi/document";

/**
 * The published contract against the routes that actually exist.
 *
 * The OpenAPI document is generated from the schemas, so it cannot describe a
 * *field* that does not exist — but nothing stops it describing the wrong set of
 * *paths*, because which routes exist and what guards them is the one part
 * written by hand. A route added without a `registerPath` beside it is an
 * undocumented endpoint that nobody notices until an integrator does, and a
 * `registerPath` left behind after a route is deleted is worse: it is a promise
 * the platform no longer keeps.
 *
 * So this walks the App Router directory and compares.
 */

const API_DIR = resolve(import.meta.dirname, "../src/app/api");

/**
 * The two paths that serve the document itself. They are deliberately absent
 * from it: a contract that describes where to fetch the contract is a curiosity
 * rather than a fact an integrator needs.
 */
const UNDOCUMENTED = new Set(["/openapi.json", "/docs"]);

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * True when every way of satisfying the operation's security needs a session.
 * An empty alternative — `{}` — is OpenAPI's way of saying "or nothing".
 */
function requiresSession(operation: Record<string, unknown>): boolean {
  const security = (operation["security"] as Record<string, unknown>[] | undefined) ?? [];
  return (
    security.length > 0 && security.every((alternative) => Object.keys(alternative).length > 0)
  );
}

interface RouteFile {
  path: string;
  methods: string[];
}

function collect(dir: string, prefix = ""): RouteFile[] {
  const found: RouteFile[] = [];

  for (const entry of readdirSync(dir).sort()) {
    const full = resolve(dir, entry);

    if (statSync(full).isDirectory()) {
      // `[runId]` in a directory name is `{runId}` in a URL template.
      const segment =
        entry.startsWith("[") && entry.endsWith("]") ? `{${entry.slice(1, -1)}}` : entry;
      found.push(...collect(full, `${prefix}/${segment}`));
      continue;
    }

    if (entry !== "route.ts") continue;

    const source = readFileSync(full, "utf8");
    const methods = METHODS.filter((method) =>
      new RegExp(`^export\\s+(?:async\\s+)?function\\s+${method.toUpperCase()}\\b`, "m").test(
        source,
      ),
    );
    found.push({ path: prefix === "" ? "/" : prefix, methods });
  }

  return found;
}

const routes = collect(API_DIR).filter((route) => !UNDOCUMENTED.has(route.path));
const document = openApiDocument();

describe("the OpenAPI document and the routes", () => {
  it("finds the routes at all — a silent empty walk would pass every test below", () => {
    expect(routes.length).toBeGreaterThan(15);
    expect(routes.every((route) => route.methods.length > 0)).toBe(true);
  });

  it("documents every route that exists", () => {
    const documented = new Set(Object.keys(document.paths ?? {}));
    const missing = routes.map((route) => route.path).filter((path) => !documented.has(path));

    expect(missing, "routes with no registerPath in lib/openapi/document.ts").toEqual([]);
  });

  it("describes no route that does not exist", () => {
    const real = new Set(routes.map((route) => route.path));
    const invented = Object.keys(document.paths ?? {}).filter((path) => !real.has(path));

    expect(invented, "documented paths with no route handler behind them").toEqual([]);
  });

  it("documents exactly the methods each route handles", () => {
    const wrong: string[] = [];

    for (const route of routes) {
      const documented = Object.keys(document.paths?.[route.path] ?? {}).filter((key) =>
        (METHODS as readonly string[]).includes(key),
      );
      const expected = [...route.methods].sort();
      if (JSON.stringify(documented.sort()) !== JSON.stringify(expected)) {
        wrong.push(`${route.path}: handles [${expected}], documents [${documented.sort()}]`);
      }
    }

    expect(wrong).toEqual([]);
  });
});

describe("what the document promises about itself", () => {
  const operations = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    Object.entries(item as Record<string, unknown>)
      .filter(([method]) => (METHODS as readonly string[]).includes(method))
      .map(([method, operation]) => ({
        path,
        method,
        operation: operation as Record<string, unknown>,
      })),
  );

  it("gives every operation a unique operationId, because clients are named from it", () => {
    const ids = operations.map((o) => o.operation["operationId"]);
    expect(ids.filter((id) => !id)).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * An operation that *requires* a session can answer 401, and saying so is not
   * padding: a client generated from a document that omits it has no branch for
   * the session expiring, which is the one failure that happens to everybody.
   *
   * An operation that merely *accepts* one is excluded by the empty
   * alternative in its `security` — signing out and asking who is signed in
   * both answer without a session rather than refusing.
   */
  it("says that an operation requiring a session can refuse the caller", () => {
    const missing = operations
      .filter((o) => requiresSession(o.operation))
      .filter((o) => !Object.keys(o.operation["responses"] as object).includes("401"))
      .map((o) => `${o.method.toUpperCase()} ${o.path}`);

    expect(missing).toEqual([]);
  });

  it("guards every /admin path and leaves the public ones public", () => {
    // The only two paths a caller reaches with no session at all: signing in,
    // and the endpoint the monitoring system polls (NFR-16).
    const PUBLIC = ["/auth/login", "/health"];

    for (const operation of operations) {
      const anySecurity = ((operation.operation["security"] as unknown[]) ?? []).length > 0;
      expect(anySecurity, `${operation.method.toUpperCase()} ${operation.path}`).toBe(
        !PUBLIC.includes(operation.path),
      );
    }

    // FA-11: root, and a 403 is how the document says so.
    const admin = operations.filter((o) => o.path.startsWith("/admin"));
    expect(admin.length).toBeGreaterThan(0);
    for (const operation of admin) {
      expect(
        Object.keys(operation.operation["responses"] as object),
        `${operation.method.toUpperCase()} ${operation.path}`,
      ).toContain("403");
    }
  });
});
