"use client";

import { QueryClient, QueryClientProvider, type DefaultOptions } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

/**
 * The defaults every query in the interface runs with.
 *
 * `retry: false` on purpose. A 401 is not a transient failure to retry — it
 * means the session is gone and the interface should say so once, rather than
 * three times with a delay in between.
 *
 * `staleTime` is ten seconds: long enough that a screen does not re-read itself
 * while it is being looked at, short enough that nothing goes stale underneath
 * its reader. It is exported because the component tests run against it — a
 * test client with react-query's own defaults is a test of a different
 * application, and the difference between the two is exactly the sort of thing
 * that hides a defect until it reaches CI (see `apps/frontend/test/
 * runConsole.transcript.test.tsx`).
 */
export const QUERY_DEFAULTS: NonNullable<DefaultOptions["queries"]> = {
  retry: false,
  refetchOnWindowFocus: false,
  staleTime: 10_000,
};

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: QUERY_DEFAULTS } }));

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
