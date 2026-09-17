"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import type { AreaCategory, AreaSummary } from "@scriptoria/contracts";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

/**
 * NFR-13's layout: a left navigation bar, and everything else to the right of
 * it. The navigation is category, then area, then that area's scripts — which
 * is also the order somebody thinks in when they come here to run something.
 *
 * FA-03.6 decides what the landing page is: deliberately empty, with the areas
 * listed on the left. Opening one is an explicit click. That is a requirement
 * rather than an oversight — a dashboard that guesses what you wanted is a
 * dashboard that is wrong most of the time.
 */

const CATEGORY_LABEL: Record<AreaCategory, string> = {
  "one-off": "One-off scripts",
  recurring: "Recurring scripts",
};

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const client = useQueryClient();
  const session = useSession();
  const areas = useQuery({ queryKey: ["areas"], queryFn: () => api.areas() });

  const user = session.data?.user ?? null;
  const signedOut = !session.isLoading && !user;

  useEffect(() => {
    if (signedOut) router.replace("/login");
  }, [signedOut, router]);

  // Nothing of the application is rendered while the session is unknown or
  // gone, so there is never a frame of it visible to somebody who is not
  // signed in — including the moment between deciding to redirect and arriving.
  if (session.isLoading || !user) return null;

  const signOut = async (): Promise<void> => {
    await api.logout();
    client.clear();
    router.replace("/login");
  };

  return (
    <div className="flex h-full">
      <nav className="flex w-64 shrink-0 flex-col border-r border-line bg-surface">
        <Link href="/" className="border-b border-line px-5 py-4">
          <span className="text-sm font-semibold tracking-tight text-ink">Scriptoria</span>
          <span className="mt-0.5 block text-[11px] text-ink-faint">
            {user?.role === "root" ? "Root account" : "Administrator"}
          </span>
        </Link>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <AreaList areas={areas.data ?? []} loading={areas.isLoading} />
        </div>

        <div className="border-t border-line px-5 py-3">
          <p className="truncate text-xs font-medium text-ink">{user?.displayName}</p>
          <p className="truncate text-[11px] text-ink-faint">{user?.username}</p>
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-2 text-[11px] text-ink-muted underline-offset-2 hover:text-ink hover:underline"
          >
            Sign out
          </button>
        </div>
      </nav>

      <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}

function AreaList({ areas, loading }: { areas: AreaSummary[]; loading: boolean }) {
  const pathname = usePathname();

  if (loading) return <p className="px-2 text-xs text-ink-faint">Loading areas…</p>;

  if (areas.length === 0) {
    /**
     * FA-01.4, and the one empty state in this product that must not look like
     * a failure: an account in no entitled group authenticates perfectly well
     * and sees nothing. There is no error here, nothing to retry, and nobody to
     * escalate to except whoever maintains the directory groups.
     */
    return (
      <div className="rounded-[var(--radius-panel)] bg-surface-sunken px-3 py-3">
        <p className="text-xs font-medium text-ink">No areas yet</p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
          Your account is signed in, and none of its directory groups is entitled to an area
          yet. Ask whoever maintains the group mapping to add one.
        </p>
      </div>
    );
  }

  const categories = [...new Set(areas.map((area) => area.category))];

  return (
    <div className="space-y-5">
      {categories.map((category) => (
        <section key={category}>
          <h2 className="px-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            {CATEGORY_LABEL[category]}
          </h2>
          <ul className="mt-1.5 space-y-0.5">
            {areas
              .filter((area) => area.category === category)
              .map((area) => {
                const active = pathname === `/areas/${area.id}`;
                return (
                  <li key={area.id}>
                    <Link
                      href={`/areas/${area.id}`}
                      className={`block truncate rounded-[var(--radius-control)] px-2 py-1.5 text-[13px] ${
                        active
                          ? "bg-accent-quiet font-medium text-accent"
                          : "text-ink-muted hover:bg-surface-sunken hover:text-ink"
                      }`}
                    >
                      {area.name}
                    </Link>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}
