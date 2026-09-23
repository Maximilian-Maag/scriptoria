#!/usr/bin/env bash
# scriptoria:title        Long watch (fixture)
# scriptoria:description  Reads a counter every second and keeps going until somebody stops it.
# scriptoria:criticality  read-only
# scriptoria:interactive  false
# scriptoria:outputs      /opt/scriptoria/export
#
# The third fixture script exists for one requirement: FA-08.3 stops a read-only
# script *immediately*, with no confirmation, and that can only be observed on a
# script that is still running when the operator decides to stop it. Both other
# fixtures are either finished in a couple of seconds or interactive, and
# `modifying` besides.
#
# It is read-only in the strict sense ADR-004 means: it touches nothing outside
# its own output directory, and it declares that in its header.
set -euo pipefail

EXPORT_DIR="/opt/scriptoria/export/$(date +%Y-%m-%d)"
mkdir -p "$EXPORT_DIR"

# A script this product stops has to be one that stops when it is told to. The
# platform sends SIGINT to the whole process group first (ADR-003), so this
# trap is what a real script's own cleanup would be.
trap 'echo; echo "interrupted by the platform"; exit 130' INT TERM

echo "=== Long watch ==="
echo "Reading until stopped."

tick=0
while true; do
  tick=$((tick + 1))
  echo "tick ${tick} at $(date -Is)"
  sleep 1
done
