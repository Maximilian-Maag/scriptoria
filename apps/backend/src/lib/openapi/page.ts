import { openApiDocument } from "./document";

/**
 * The contract, rendered server-side into one self-contained page.
 *
 * Swagger UI would be the obvious choice and is deliberately not used. NFR-01
 * puts this platform in a private network with no route out: a page that pulls
 * its own renderer off a CDN is a page that is blank in exactly the environment
 * this product runs in, and vendoring the dist bundle buys an asset-copying
 * build step for a document of thirty endpoints. This is HTML and nothing else
 * — no script, no font, no request after the first one.
 *
 * It renders what a reader needs to call the API and stops there: the paths by
 * tag, what each one is for, what it takes and what it can answer, and the
 * schemas underneath. Anything more exact is in `/api/openapi.json`, which is
 * the machine-readable artefact and the one to generate a client from.
 */

const escape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Backticks to `<code>`, and nothing else. Escaping first, always. */
const inline = (text: string): string => escape(text).replaceAll(/`([^`]+)`/g, "<code>$1</code>");

/** The same, plus blank lines to paragraphs. The whole of the markup support. */
const prose = (text: string): string =>
  text
    .split("\n\n")
    .map((paragraph) => `<p>${inline(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");

const METHOD_ORDER = ["get", "post", "patch", "put", "delete"];

interface Operation {
  tags?: string[];
  summary?: string;
  description?: string;
  security?: unknown[];
  parameters?: { name: string; in: string; required?: boolean; description?: string }[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { description?: string; content?: Record<string, unknown> }>;
}

/** `#/components/schemas/Run` → `Run`, for anything that carries a $ref. */
function schemaName(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const ref = (node as { $ref?: string }).$ref;
  if (typeof ref === "string") return ref.split("/").pop() ?? null;
  const items = (node as { items?: unknown }).items;
  if (items) {
    const inner = schemaName(items);
    return inner ? `${inner}[]` : null;
  }
  return null;
}

function contentSummary(content: Record<string, { schema?: unknown }> | undefined): string {
  if (!content) return "";
  return Object.entries(content)
    .map(([type, value]) => {
      const name = schemaName(value?.schema);
      return name
        ? `<a class="ref" href="#schema-${escape(name.replace("[]", ""))}">${escape(name)}</a>`
        : `<code>${escape(type)}</code>`;
    })
    .join(" ");
}

export function openApiHtml(): string {
  // Narrowed to the parts this renderer walks. Through `unknown`, because the
  // generator's own type is wider than what is read here and the two only have
  // to agree on the fields below.
  const document = openApiDocument() as unknown as {
    info: { title: string; version: string; description?: string };
    tags?: { name: string; description?: string }[];
    paths?: Record<string, Record<string, Operation>>;
    components?: { schemas?: Record<string, unknown> };
  };

  const operations: { tag: string; path: string; method: string; operation: Operation }[] = [];
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!METHOD_ORDER.includes(method)) continue;
      operations.push({ tag: operation.tags?.[0] ?? "Other", path, method, operation });
    }
  }

  const tags = document.tags ?? [];
  const sections = tags
    .map((tag) => {
      const mine = operations
        .filter((entry) => entry.tag === tag.name)
        .sort(
          (a, b) =>
            a.path.localeCompare(b.path) ||
            METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
        );
      if (mine.length === 0) return "";

      return `
        <section>
          <h2 id="tag-${escape(tag.name)}">${escape(tag.name)}</h2>
          ${tag.description ? `<p class="lede">${escape(tag.description)}</p>` : ""}
          ${mine.map(({ path, method, operation }) => operationHtml(path, method, operation)).join("")}
        </section>`;
    })
    .join("");

  const schemas = Object.entries(document.components?.schemas ?? {})
    .map(
      ([name, schema]) => `
        <article class="schema" id="schema-${escape(name)}">
          <h3>${escape(name)}</h3>
          <pre>${escape(JSON.stringify(schema, null, 2))}</pre>
        </article>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(document.info.title)} — REST contract</title>
<style>
  :root {
    --ink: #22252c; --ink-muted: #5b6070; --ink-faint: #868c9c;
    --line: #e2e5ec; --surface: #fff; --canvas: #f8f9fb; --accent: #2f5bd0;
    --get: #2f7d4f; --post: #2f5bd0; --patch: #8a6410; --delete: #b23b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #e6e8ee; --ink-muted: #a2a8b8; --ink-faint: #7c8394;
      --line: #2d323c; --surface: #1b1e24; --canvas: #14171c; --accent: #8aa9f0;
      --get: #74c08f; --post: #8aa9f0; --patch: #d5ab5c; --delete: #e08585;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--canvas); color: var(--ink);
    font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 56rem; margin: 0 auto; padding: 2.5rem 1.25rem 6rem; }
  code, pre { font-family: ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace; }
  code { font-size: 0.9em; }
  h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1.05rem; margin: 3rem 0 0.25rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--line); }
  h3 { font-size: 0.9rem; margin: 0 0 0.5rem; }
  p { margin: 0.5rem 0; }
  .lede, .muted { color: var(--ink-muted); }
  .version { color: var(--ink-faint); font-size: 0.8rem; }
  .op {
    background: var(--surface); border: 1px solid var(--line); border-radius: 0.5rem;
    padding: 0.9rem 1rem; margin-top: 0.75rem;
  }
  .sig { display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; }
  .method { font-weight: 700; font-size: 0.72rem; letter-spacing: 0.06em; }
  .get { color: var(--get); } .post { color: var(--post); }
  .patch { color: var(--patch); } .put { color: var(--patch); } .delete { color: var(--delete); }
  .path { font-family: ui-monospace, Menlo, monospace; font-size: 0.86rem; }
  .summary { color: var(--ink-muted); font-size: 0.86rem; }
  .guard {
    margin-left: auto; font-size: 0.68rem; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--ink-faint); border: 1px solid var(--line); border-radius: 0.25rem; padding: 0 0.35rem;
  }
  .detail { font-size: 0.86rem; color: var(--ink-muted); }
  .detail p { margin: 0.5rem 0; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.6rem; font-size: 0.82rem; }
  td, th { text-align: left; padding: 0.25rem 0.75rem 0.25rem 0; vertical-align: top; }
  th { color: var(--ink-faint); font-weight: 600; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; }
  td.code { font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
  a { color: var(--accent); }
  a.ref { text-decoration: none; border-bottom: 1px dotted currentColor; }
  .schema { background: var(--surface); border: 1px solid var(--line); border-radius: 0.5rem; padding: 0.9rem 1rem; margin-top: 0.75rem; }
  pre { margin: 0; overflow-x: auto; font-size: 0.75rem; line-height: 1.5; color: var(--ink-muted); }
  nav { margin: 1.5rem 0 0; font-size: 0.85rem; }
  nav a { margin-right: 1rem; white-space: nowrap; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${escape(document.info.title)}</h1>
  <p class="version">Version ${escape(document.info.version)} ·
    <a href="/api/openapi.json">openapi.json</a></p>
  ${document.info.description ? `<div class="lede">${prose(document.info.description)}</div>` : ""}
  <nav>${tags.map((tag) => `<a href="#tag-${escape(tag.name)}">${escape(tag.name)}</a>`).join("")}</nav>
  ${sections}
  <section>
    <h2 id="schemas">Schemas</h2>
    <p class="lede">As JSON Schema, generated from the Zod definitions the routes validate with.</p>
    ${schemas}
  </section>
</div>
</body>
</html>`;
}

function operationHtml(path: string, method: string, operation: Operation): string {
  const guard =
    operation.security?.length === 0
      ? "Public"
      : path.startsWith("/admin") || path === "/schedules/{scheduleId}"
        ? "Root only"
        : "Session";

  const parameters = (operation.parameters ?? []).filter((p) => p.in !== "cookie");

  const responses = Object.entries(operation.responses ?? {})
    .map(
      ([status, response]) => `
        <tr>
          <td class="code">${escape(status)}</td>
          <td>${inline(response.description ?? "")}</td>
          <td>${contentSummary(response.content as Record<string, { schema?: unknown }>)}</td>
        </tr>`,
    )
    .join("");

  return `
    <div class="op">
      <div class="sig">
        <span class="method ${escape(method)}">${escape(method.toUpperCase())}</span>
        <span class="path">${escape(path)}</span>
        <span class="guard">${guard}</span>
      </div>
      ${operation.summary ? `<p class="summary">${inline(operation.summary)}</p>` : ""}
      ${operation.description ? `<div class="detail">${prose(operation.description)}</div>` : ""}
      ${
        parameters.length > 0
          ? `<table>
              <tr><th>Parameter</th><th>In</th><th></th></tr>
              ${parameters
                .map(
                  (parameter) => `<tr>
                    <td class="code">${escape(parameter.name)}${parameter.required ? "" : "?"}</td>
                    <td class="muted">${escape(parameter.in)}</td>
                    <td class="muted">${inline(parameter.description ?? "")}</td>
                  </tr>`,
                )
                .join("")}
            </table>`
          : ""
      }
      ${
        operation.requestBody
          ? `<table>
              <tr><th>Request body</th><th></th><th></th></tr>
              <tr>
                <td class="code">${operation.requestBody.required ? "required" : "optional"}</td>
                <td></td>
                <td>${contentSummary(operation.requestBody.content)}</td>
              </tr>
            </table>`
          : ""
      }
      ${responses ? `<table><tr><th>Answers</th><th></th><th></th></tr>${responses}</table>` : ""}
    </div>`;
}
