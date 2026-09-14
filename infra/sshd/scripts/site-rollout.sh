#!/usr/bin/env bash
# scriptoria:title        Site rollout (fixture)
# scriptoria:description  Walks site by site and asks for confirmation before each one.
#                  Stands in for the iterative dialogue scripts.
# scriptoria:criticality  modifying
# scriptoria:interactive  true
# scriptoria:outputs      /opt/scriptoria/export
#
# This is the fixture that matters. It exercises everything the terminal exists
# for: a real PTY, a prompt that blocks on stdin, output that is part of the
# interaction rather than its end (FA-06.3), a loop with no natural end (FA-08.2),
# and a `modifying` criticality so the abort confirmation from ADR-003 applies.
set -euo pipefail

EXPORT_DIR="/opt/scriptoria/export/$(date +%Y-%m-%d)"
mkdir -p "$EXPORT_DIR"
LOG="${EXPORT_DIR}/rollout.log"

echo "=== Site rollout ==="
echo "This script MODIFIES target systems. Abort leaves sites partially done."
echo

for site in alpha bravo charlie delta echo; do
  printf 'Apply configuration to site %s? [y/N/q] ' "$site"
  read -r answer
  case "$answer" in
    y|Y)
      echo "  applying ..."
      sleep 1
      echo "$(date -Is) applied ${site}" >> "$LOG"
      echo "  done: ${site}"
      ;;
    q|Q)
      echo "Stopping at operator request."
      break
      ;;
    *)
      echo "  skipped: ${site}"
      ;;
  esac
done

echo
echo "Log written to ${LOG}"
