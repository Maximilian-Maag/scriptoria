// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionUser } from "@scriptoria/contracts";
import { AppShell } from "../src/components/AppShell";

/**
 * The two states of the left navigation that must not be confused
 * (FA-01.4, issue #57).
 *
 * FA-01.4 licenses exactly one screen that looks empty, and it is a statement
 * about the account's directory groups: signed in, entitled to nothing. Its
 * whole point is the converse too — that screen is *not* an error and must
 * never be dressed as one. A read that failed is the mirror image of that
 * mistake: an outage rendered as a statement about the user's entitlements,
 * complete with advice to go and fix a group mapping that is not broken.
 *
 * Real React 19 and real react-query on jsdom; the only thing faked is the
 * wire, and it is faked at `fetch`, which is where the browser would meet it.
 */

const replace = vi.hoisted(() => vi.fn());

// `useRouter` throws outside a mounted app router, which is the one piece of
// Next.js this test does not have. The shell's own behaviour is what is under
// test, not the router's.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/",
}));

const USER: SessionUser = {
  username: "jdoe",
  displayName: "Jane Doe",
  role: "administrator",
  groups: ["scriptoria-operators"],
  areaIds: ["b1e1f3a7-7a2d-4b74-8b6d-3b3e8b8f5f3f"],
  expiresAt: "2026-09-24T04:05:06.000Z",
};

interface Answer {
  status: number;
  body: unknown;
}

/** Routes the two calls the shell makes, by the path it asks for. */
function answering(routes: Record<string, Answer>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^\/api\/proxy/, "");
      const answer = routes[path];
      if (!answer) return new Response("", { status: 404 });
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function renderShell(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AppShell>
        <p>the page</p>
      </AppShell>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockClear();
});

describe("the left navigation when the areas call fails", () => {
  it("says the areas could not be loaded, and not that the account has none", async () => {
    answering({
      "/auth/session": { status: 200, body: { user: USER } },
      "/areas": {
        status: 500,
        body: { error: { code: "internal", message: "The areas could not be read" } },
      },
    });

    renderShell();

    expect(await screen.findByText("Could not load the areas")).toBeTruthy();
    expect(screen.getByText("The areas could not be read")).toBeTruthy();

    // FA-01.4's empty state is a claim about the account's directory groups.
    // A failed read is not evidence for it, so neither half of it may appear.
    expect(screen.queryByText("No areas yet")).toBeNull();
    expect(screen.queryByText(/none of its directory groups/)).toBeNull();
  });

  it("still renders FA-01.4's empty state when the session really has no areas", async () => {
    answering({
      "/auth/session": { status: 200, body: { user: { ...USER, groups: [], areaIds: [] } } },
      "/areas": { status: 200, body: [] },
    });

    renderShell();

    expect(await screen.findByText("No areas yet")).toBeTruthy();
    expect(screen.queryByText(/Could not load the areas/)).toBeNull();
  });

  it("lists the areas the session is entitled to", async () => {
    answering({
      "/auth/session": { status: 200, body: { user: USER } },
      "/areas": {
        status: 200,
        body: [
          {
            id: "b1e1f3a7-7a2d-4b74-8b6d-3b3e8b8f5f3f",
            name: "Core network",
            description: "",
            category: "recurring",
          },
        ],
      },
    });

    renderShell();

    expect(await screen.findByRole("link", { name: "Core network" })).toBeTruthy();
    expect(screen.queryByText(/Could not load the areas/)).toBeNull();
  });

  it("keeps the areas on screen when a refetch fails, with the failure said above them", async () => {
    const routes: Record<string, Answer> = {
      "/auth/session": { status: 200, body: { user: USER } },
      "/areas": {
        status: 200,
        body: [
          {
            id: "b1e1f3a7-7a2d-4b74-8b6d-3b3e8b8f5f3f",
            name: "Core network",
            description: "",
            category: "recurring",
          },
        ],
      },
    };
    answering(routes);

    const client = renderShell();
    expect(await screen.findByRole("link", { name: "Core network" })).toBeTruthy();

    // The read that failed is the *second* one. react-query keeps the last
    // successful response, so those links are still the operator's — and the
    // failure is still a failure, which is the half #57 is about.
    routes["/areas"] = {
      status: 500,
      body: { error: { code: "internal", message: "The areas could not be read" } },
    };
    await act(async () => {
      await client.refetchQueries({ queryKey: ["areas"] });
    });

    expect(await screen.findByText("Could not load the areas")).toBeTruthy();
    expect(screen.getByText("The areas could not be read")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Core network" })).toBeTruthy();
    expect(screen.queryByText("No areas yet")).toBeNull();
  });

  it("keeps the shell hidden and redirects when the session is gone", async () => {
    answering({ "/auth/session": { status: 200, body: { user: null } } });

    renderShell();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("the page")).toBeNull();
  });
});
