#!/bin/sh
#
# The proxy's routing, exercised: this repository's nginx.conf in a container, in front of two
# stubs that answer with their own port.
#
# `nginx -t` proves the file parses. It does not prove that /terminal reaches the control plane,
# that /healthz is rewritten onto the control plane's /api/health, or that everything else stays
# on the frontend — and those four facts are the whole of the deployment's reachability, because
# NFR-01 gives the proxy the only public address.
#
# Run by `make deploy-check`, and by CI with it. Needs a container runtime, python3, openssl and
# curl. It binds 80 and 443 because the configuration listens there: a test that listened on other
# ports would be testing a different file. Where those ports are taken, it says so and passes, the
# same way the unit check filters a missing podman binary — a busy machine is a fact about the
# machine, not about the proxy.
#
#   ./nginx.test.sh

set -eu

here=$(cd "$(dirname "$0")" && pwd)
deploy=$(dirname "$here")
runtime=${RUNTIME:-docker}
image=${NGINX_IMAGE:-nginx:1.27-alpine}

# A skip is reported as a skip, in the same shape as a pass: a check that silently passes when it
# did nothing is worse than no check, and this one cannot assert anything without the ports the
# configuration listens on.
skip() {
    echo "  the proxy's routing was skipped: $1"
    exit 0
}

command -v "$runtime" > /dev/null 2>&1 || skip "$runtime is not installed here"
busy=$(ss -ltn 2>/dev/null | awk '$4 ~ /:80$/ || $4 ~ /:443$/' | wc -l)
[ "$busy" -eq 0 ] || skip "80 or 443 is already in use on this machine"
command -v python3 > /dev/null 2>&1 || skip "python3 is not installed here"

work=$(mktemp -d)
stub_pids=""
container="scriptoria-nginx-test-$$"

cleanup() {
    [ -n "$container" ] && "$runtime" rm -f "$container" > /dev/null 2>&1 || true
    for pid in $stub_pids; do kill "$pid" 2> /dev/null || true; done
    rm -rf "$work"
}
trap cleanup EXIT INT TERM

# ── The two stubs ─────────────────────────────────────────────────────────────
# Each answers with its own port and the path it was asked for, so an assertion can say which
# upstream served it and what nginx rewrote the path to. An upgrade request is refused with 401,
# which is what the control plane does without a session — the point being that it *arrived*.
cat > "$work/stub.py" <<'STUB'
import http.server
import sys

port = int(sys.argv[1])


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        upgrade = self.headers.get("Upgrade") or ""
        body = f"port={port} path={self.path} upgrade={upgrade}".encode()
        self.send_response(401 if upgrade else 200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
STUB

python3 "$work/stub.py" 3000 > /dev/null 2>&1 &
stub_pids="$stub_pids $!"
python3 "$work/stub.py" 3001 > /dev/null 2>&1 &
stub_pids="$stub_pids $!"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=scriptoria.invalid" \
    -keyout "$work/privkey.pem" -out "$work/fullchain.pem" 2> /dev/null

# Waited for rather than slept through: a stub that has not bound its port yet answers nothing,
# and an assertion run against nothing fails for the wrong reason.
i=0
while [ "$i" -lt 50 ]; do
    if curl -s -o /dev/null --max-time 1 http://127.0.0.1:3001/ && curl -s -o /dev/null --max-time 1 http://127.0.0.1:3000/; then
        break
    fi
    i=$((i + 1))
    sleep 0.1
done

"$runtime" run -d --rm --name "$container" --network=host \
    --entrypoint nginx \
    --volume "$deploy/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
    --volume "$deploy/nginx/upstreams:/etc/nginx/scriptoria/upstreams:ro" \
    --volume "$work:/etc/scriptoria/tls:ro" \
    "$image" -g 'daemon off;' > /dev/null

i=0
while [ "$i" -lt 100 ]; do
    if curl -sk -o /dev/null --max-time 1 https://127.0.0.1/; then
        break
    fi
    i=$((i + 1))
    sleep 0.1
done

# ── The cases ─────────────────────────────────────────────────────────────────
passed=0
failed=0

# expect <label> <expected substring> <actual>
expect() {
    case "$3" in
        *"$2"*) passed=$((passed + 1)) ;;
        *)
            echo "FAIL: $1" >&2
            echo "      expected to find: $2" >&2
            echo "      got: $3" >&2
            failed=$((failed + 1))
            ;;
    esac
}

code_and_location=$(curl -sk -o /dev/null -w '%{http_code} %{redirect_url}' http://127.0.0.1/ 2>&1 || true)
expect "the plain listener only redirects" "301 https://" "$code_and_location"

expect "the site goes to the frontend" "port=3000" "$(curl -sk --max-time 5 https://127.0.0.1/ 2>&1 || true)"

# The rewrite is the assertion: the control plane is asked for /api/health, not /healthz.
expect "healthz is rewritten onto the control plane's /api/health" \
    "port=3001 path=/api/health" \
    "$(curl -sk --max-time 5 https://127.0.0.1/healthz 2>&1 || true)"

# --http1.1 because a browser opens a WebSocket over HTTP/1.1 while curl negotiates h2 by default,
# and nginx does not turn an h2 request into an HTTP/1.1 upgrade. Without the flag this asserts
# 404 against a configuration that is correct.
expect "the terminal upgrade reaches the control plane" "port=3001 path=/terminal upgrade=websocket" \
    "$(curl -sk --http1.1 --max-time 5 \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
        -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==' \
        https://127.0.0.1/terminal 2>&1 || true)"

expect "the control plane's /api is not published" "port=3000" \
    "$(curl -sk --max-time 5 https://127.0.0.1/api/runs 2>&1 || true)"

if [ "$failed" -ne 0 ]; then
    echo "nginx.test: $passed case(s) held, $failed failed" >&2
    exit 1
fi
echo "  the proxy's routing reaches the control plane, and nothing else does"
