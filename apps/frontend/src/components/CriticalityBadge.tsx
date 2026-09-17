import type { Criticality } from "@scriptoria/contracts";

/**
 * FA-03.5, and the requirement the abort design hangs off.
 *
 * Some scripts only read and are effectively harmless. Others modify
 * infrastructure, and a mistake there can leave hundreds of sites in a state
 * nobody described. The safeguards inside the scripts already exist; what the
 * platform adds is making the criticality visible **before** the start.
 *
 * `unknown` is shown as its own thing rather than blank, because ADR-003 treats
 * an undeclared script as modifying and that has to be visible rather than
 * implied.
 */
const STYLES: Record<Criticality, { label: string; className: string; title: string }> = {
  "read-only": {
    label: "Reads only",
    className: "bg-reads-quiet text-reads",
    title: "This script reads. It does not change the systems it touches.",
  },
  modifying: {
    label: "Modifies",
    className: "bg-modifies-quiet text-modifies",
    title: "This script changes target systems. Stopping it needs a confirmation.",
  },
  unknown: {
    label: "Undeclared",
    className: "bg-undeclared-quiet text-undeclared",
    title:
      "This script declares no criticality, so it is treated as modifying. An undeclared script is not a safe script.",
  },
};

export function CriticalityBadge({
  criticality,
  overridden = false,
}: {
  criticality: Criticality;
  /** True when an administrator corrected the script's own declaration. */
  overridden?: boolean;
}) {
  const style = STYLES[criticality];

  return (
    <span
      title={style.title}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.className}`}
    >
      {style.label}
      {overridden ? <span className="opacity-60">· set here</span> : null}
    </span>
  );
}
