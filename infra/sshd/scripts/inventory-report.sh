#!/usr/bin/env bash
# scriptoria:title        Interface inventory (fixture)
# scriptoria:description  Reads a canned device list and writes one CSV per site into the
#                  export directory. Reads only — it touches nothing.
# scriptoria:criticality  read-only
# scriptoria:interactive  false
# scriptoria:outputs      /opt/scriptoria/export
#
# The non-interactive case (FA-05.4, NFR-22): no user answers anything, and the
# run must still be recorded in full as a run, a terminal history and a result set.
set -euo pipefail

EXPORT_DIR="/opt/scriptoria/export/$(date +%Y-%m-%d)"
mkdir -p "$EXPORT_DIR"

for site in alpha bravo charlie delta; do
  echo "Reading interfaces for site: ${site}"
  printf 'device,interface,status\n' > "${EXPORT_DIR}/${site}.csv"
  for n in 1 2 3; do
    printf 'sw-%s-%02d,GigabitEthernet0/%d,up\n' "$site" "$n" "$n" >> "${EXPORT_DIR}/${site}.csv"
  done
  sleep 0.3
done

echo "Wrote $(ls -1 "$EXPORT_DIR" | wc -l) files to ${EXPORT_DIR}"
