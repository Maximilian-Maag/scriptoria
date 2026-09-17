"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * FA-03.3 — the two things an area holds: the scripts available in it, and what
 * has actually been run.
 *
 * They are separate routes rather than one page with a toggle, so each is a link
 * somebody can keep, send to a colleague, or come back to after the tab that
 * started the run is long closed. That is the whole point of the history
 * existing (FA-05.4).
 */
export function AreaTabs({ areaId }: { areaId: string }) {
  const pathname = usePathname();
  const onRuns = pathname.endsWith("/runs");
  const onSchedules = pathname.endsWith("/schedules");

  return (
    <nav className="flex gap-1">
      <Tab href={`/areas/${areaId}`} active={!onRuns && !onSchedules}>
        Scripts
      </Tab>
      <Tab href={`/areas/${areaId}/runs`} active={onRuns}>
        Runs
      </Tab>
      {/* FA-03.3 names both halves of what an area holds: the scripts, and the
          jobs. This is the second half. */}
      <Tab href={`/areas/${areaId}/schedules`} active={onSchedules}>
        Schedules
      </Tab>
    </nav>
  );
}

function Tab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-[var(--radius-control)] px-2.5 py-1 text-[13px] ${
        active
          ? "bg-accent-quiet font-medium text-accent"
          : "text-ink-muted hover:bg-surface-sunken hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}
