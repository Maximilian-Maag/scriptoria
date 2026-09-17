/**
 * FA-03.6 — the landing page is deliberately empty.
 *
 * "Nothing else appears on the dashboard" is the requirement, word for word.
 * The areas are in the left navigation and opening one is an explicit click, so
 * this page has one job: to say where you are and to not be a wall of widgets
 * nobody asked for.
 */
export default function DashboardPage() {
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="max-w-md text-center">
        <h1 className="text-sm font-semibold text-ink">Pick an area to begin</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
          The areas your groups are entitled to are listed on the left. Opening one shows the
          scripts it holds, each with what it does and whether it only reads or also changes
          things.
        </p>
      </div>
    </div>
  );
}
