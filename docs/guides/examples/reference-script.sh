#!/usr/bin/env bash
# scriptoria:title        Reference script (template)
# scriptoria:description  Copy-me template for a script the platform runs: declares its metadata,
#                         writes one dated result file, reports progress on the terminal, and
#                         unwinds cleanly when it is stopped.
# scriptoria:criticality  read-only        # read-only | modifying — see docs/guides/script-vm.md
# scriptoria:interactive  false            # true if it prompts on stdin
# scriptoria:outputs      /opt/scriptoria/export
#
# Everything a script VM has to get right, in the order the platform meets it:
#
#   · the header block above, which is what the catalog shows before anybody runs anything
#     (ADR-004). `criticality` decides whether the interface warns, so get it right: an
#     undeclared script is treated as `modifying`, and that is the safe default, not a bug;
#   · results written *under* the declared output directory, because that is the directory the
#     platform lists after the run and treats as this run's results (FA-09);
#   · progress on stdout as plain lines, so the live terminal and the transcript of a finished
#     run both read correctly (FA-07.2);
#   · a trap on INT/TERM, because stopping is a courtesy the platform asks for and a script has
#     to accept (ADR-003). The platform cannot roll anything back (NFR-06);
#   · an exit code that means what it says: 0 = the work was done.
#
# Copy it, replace the three TEMPLATE blocks, and it is a script the platform can run. It is
# parsed by packages/core's header parser in a test, so the example cannot drift from the parser.

set -euo pipefail

# ── TEMPLATE 1: where this script's results go ────────────────────────────────
# Must match `scriptoria:outputs` above. A per-date (or per-run) subdirectory is what makes
# "the files this run produced" unambiguous.
OUTPUT_ROOT="${SCRIPTORIA_OUTPUT_ROOT:-/opt/scriptoria/export}"
OUTPUT_DIR="${OUTPUT_ROOT}/$(date +%Y-%m-%d)"

# ── TEMPLATE 2: what this script works on ─────────────────────────────────────
# A real script reads its sites, hosts or accounts from here — a file, an API, a source of
# truth it already had. The platform passes no parameters: FA-05.5 makes the parameter set a
# property of the script, and questions go through the terminal after the start (FA-06).
TARGETS_FILE="${TARGETS_FILE:-/etc/scriptoria-targets.txt}"

STARTED_AT="$(date -Is)"
RUN_ID="${SCRIPTORIA_RUN_ID:-local-$(date +%s)}"
REPORT="${OUTPUT_DIR}/reference-${RUN_ID}.txt"
FIRED=0

# ── TEMPLATE 3: unwinding ─────────────────────────────────────────────────────
# SIGINT first, then SIGTERM, then SIGKILL (ADR-003). Only the first two are catchable, and a
# script that ignores them is killed mid-write. Finishing the current item and exiting non-zero
# is the whole of the unwinding the platform can offer.
trap 'FIRED=1; echo; echo "stop requested (${STARTED_AT} → $(date -Is)) — finishing this item"; exit 130' INT TERM

mkdir -p "${OUTPUT_DIR}"

echo "=== Reference script ==="
echo "run        ${RUN_ID}"
echo "started    ${STARTED_AT}"
echo "results    ${OUTPUT_DIR}"
echo

if [ ! -r "${TARGETS_FILE}" ]; then
  # "I could not do the work" is a non-zero exit, not a zero one. A script that reports success
  # after doing nothing is worse than one that fails: the platform records what it said.
  echo "cannot read ${TARGETS_FILE} — nothing to do" >&2
  exit 2
fi

{
  echo "run=${RUN_ID}"
  echo "started=${STARTED_AT}"
  echo "targets=${TARGETS_FILE}"
  echo
} > "${REPORT}"

count=0
while IFS= read -r target; do
  # Blank lines and comments are not targets: this is also where a hand-maintained list keeps
  # its notes.
  case "${target}" in '' | '#'*) continue ;; esac

  count=$((count + 1))
  echo "[${count}] ${target}"

  # The work itself. Read-only here, and a failure on one target is recorded rather than fatal:
  # a report that says which item failed is more useful than a run that stopped at the first one.
  if ping -c 1 -W 1 "${target}" > /dev/null 2>&1; then
    echo "${target} reachable" >> "${REPORT}"
  else
    echo "${target} unreachable" >> "${REPORT}"
  fi

  # A stop requested during the previous item is honoured between items, which is what makes
  # this a clean stop rather than a kill.
  [ "${FIRED}" -eq 0 ] || exit 130
done < "${TARGETS_FILE}"

echo
echo "wrote ${REPORT} (${count} targets, $(date -Is))"

# Exit 0 means the work was done. Everything above that can go wrong already has.
exit 0
