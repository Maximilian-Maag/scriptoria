#!/bin/sh
# Runs ONLY on a fresh volume. On an existing one, use `make test-db`.
set -eu
for db in scriptoria_test scriptoria_e2e; do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -c "CREATE DATABASE $db"
done
