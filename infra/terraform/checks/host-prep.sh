#!/bin/sh
#
# The host-prep document, rendered and read back.
#
# `terraform validate` does not evaluate a templatefile, so the way to know that the
# document a machine receives is the document it needs is to render it and look. The
# failures this catches are the quiet kind: a file path that resolves on a
# workstation and not inside the module, a loop that renders an empty list, a
# content line that comes out blank. Each produces a host that boots with no
# deployment layer on it and nothing to say about why.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
terraform=${TERRAFORM:-terraform}
deploy=$(cd "$here/../.." && pwd)/deploy

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cd "$here/host_prep"
$terraform init -backend=false -input=false > /dev/null
$terraform apply -auto-approve -input=false > /dev/null
$terraform output -raw user_data > "$tmp/host.yaml"

fail() {
    echo "host-prep: $1" >&2
    exit 1
}

head -n 1 "$tmp/host.yaml" | grep -qx '#cloud-config' ||
    fail "the document does not begin with #cloud-config, so cloud-init would ignore it"

# Every file of the deployment layer has to be in it. Counted as well as looked for:
# a file added to infra/deploy and forgotten here would otherwise be a file that
# exists on a checkout and not on a host.
files=$(find "$deploy" -type f -printf '%P\n' | sort)
written=$(grep -c '^  - path: /opt/scriptoria/deploy/' "$tmp/host.yaml" || true)

expected=$(printf '%s\n' "$files" | grep -c . || true)
[ "$written" -eq "$expected" ] ||
    fail "the document carries $written files and the deployment layer has $expected"

for file in $files; do
    grep -q "^  - path: /opt/scriptoria/deploy/$file\$" "$tmp/host.yaml" ||
        fail "$file is in the deployment layer and not in the document"
done

# A blank content line is a file that lands on the host empty.
grep -q 'content: *$' "$tmp/host.yaml" && fail "a file in the document has no content"

echo "  the host-prep document renders with all $expected files of the deployment layer in it"
