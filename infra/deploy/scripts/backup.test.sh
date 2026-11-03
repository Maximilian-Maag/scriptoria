#!/bin/sh
#
# backup.sh, exercised rather than read.
#
# The script's job is to leave a file that *is* a backup, and its failure modes are all
# about what is left behind when something goes wrong at 3am: a dump interrupted by a
# full disk, a directory that fills with the remains of an outage, a retention loop that
# deletes the backup it just took. None of that is visible by reading it, and none of it
# needs PostgreSQL to reproduce — pg_dump and pg_restore are stubs here, and what is
# under test is the script around them.
#
#   ./backup.test.sh

set -eu

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

stubs="$work/bin"
mkdir -p "$stubs" "$work/backups"

# A dump that succeeds writes something that looks like an archive; the script's job is
# everything after that.
cat > "$stubs/pg_dump" <<'STUB'
#!/bin/sh
for arg in "$@"; do
    case "$arg" in
        --file=*) printf 'custom-format archive\n' > "${arg#--file=}" ;;
    esac
done
STUB

cat > "$stubs/pg_restore" <<'STUB'
#!/bin/sh
# `--list` on a file that exists is all the verification the script asks for. Options
# are not files.
for arg in "$@"; do
    case "$arg" in
        -*) continue ;;
    esac
    [ -f "$arg" ] || exit 1
done
STUB

chmod +x "$stubs"/*
PATH="$stubs:$PATH"
export PATH

failures=0

check() {
    if [ "$2" = "$3" ]; then
        echo "  ok    $1"
    else
        echo "  FAIL  $1: expected '$3', got '$2'" >&2
        failures=$((failures + 1))
    fi
}

count() {
    ls -1 "$work/backups"/scriptoria-*.dump 2> /dev/null | wc -l | tr -d ' '
}

partials() {
    ls -1 "$work/backups"/scriptoria-*.dump.partial 2> /dev/null | wc -l | tr -d ' '
}

# ── A dump that works leaves a backup and no partial ─────────────────────────────
DATABASE_URL=postgres://x:y@z:5432/db BACKUP_DIR="$work/backups" sh "$here/backup.sh" > /dev/null
check "a good run leaves one backup" "$(count)" "1"
check "and no partial" "$(partials)" "0"

# ── A dump that fails leaves no backup ───────────────────────────────────────────
cat > "$stubs/pg_dump" <<'STUB'
#!/bin/sh
for arg in "$@"; do
    case "$arg" in
        --file=*) printf 'half a file' > "${arg#--file=}" ;;
    esac
done
exit 1
STUB
chmod +x "$stubs/pg_dump"

if DATABASE_URL=postgres://x:y@z:5432/db BACKUP_DIR="$work/backups" sh "$here/backup.sh" > /dev/null 2>&1; then
    echo "  FAIL  a failing dump should not report success" >&2
    failures=$((failures + 1))
else
    echo "  ok    a failing dump exits non-zero"
fi

check "a failing dump adds no backup" "$(count)" "1"

# The count above is weaker than it looks: two runs in the same second write to the same
# filename, so a second dump can replace the first and leave the count at one. This is
# the assertion that cannot be satisfied by a name collision — a failed dump's *content*
# must never be sitting under a backup name.
half_written=$(grep -l 'half a file' "$work/backups"/scriptoria-*.dump 2> /dev/null | wc -l | tr -d ' ')
check "no half-written dump is left under a backup name" "$half_written" "0"

check "it leaves a partial instead" "$(partials)" "1"

# ── An unreadable dump is not promoted either ────────────────────────────────────
cat > "$stubs/pg_dump" <<'STUB'
#!/bin/sh
for arg in "$@"; do
    case "$arg" in
        --file=*) printf 'custom-format archive\n' > "${arg#--file=}" ;;
    esac
done
STUB
cat > "$stubs/pg_restore" <<'STUB'
#!/bin/sh
exit 1
STUB
chmod +x "$stubs/pg_dump" "$stubs/pg_restore"

DATABASE_URL=postgres://x:y@z:5432/db BACKUP_DIR="$work/backups" sh "$here/backup.sh" > /dev/null 2>&1 || true
check "an unreadable dump does not become a backup" "$(count)" "1"

cat > "$stubs/pg_restore" <<'STUB'
#!/bin/sh
for arg in "$@"; do
    case "$arg" in
        -*) continue ;;
    esac
    [ -f "$arg" ] || exit 1
done
STUB
chmod +x "$stubs/pg_restore"

# ── Retention keeps the newest N and no partials ─────────────────────────────────
rm -f "$work/backups"/scriptoria-*.dump*
i=0
while [ "$i" -lt 5 ]; do
    touch -d "2026-01-0$((i + 1))" "$work/backups/scriptoria-2026010$((i + 1))T000000Z.dump"
    i=$((i + 1))
done
touch -d "2026-01-01" "$work/backups/scriptoria-20260101T000000Z.dump.partial"

DATABASE_URL=postgres://x:y@z:5432/db BACKUP_DIR="$work/backups" BACKUP_KEEP=3 sh "$here/backup.sh" > /dev/null
check "retention keeps three" "$(count)" "3"
check "and the stale partial is cleared" "$(partials)" "0"

if [ "$failures" -ne 0 ]; then
    exit 1
fi

echo "  backup.sh behaves: a failed or unreadable dump is never promoted, and retention keeps what it says"
