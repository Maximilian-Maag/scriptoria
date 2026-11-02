/**
 * The address the control plane records for a request that came through this
 * tier — FA-12.1's "where".
 *
 * This is decided here, in the frontend's server, because it is the only place in
 * the platform that still knows something the caller cannot invent: the socket
 * the request arrived on. Everything downstream — the proxy route, the control
 * plane — has only headers to go on, and a header is a value the caller chooses.
 *
 * Two rules, in this order:
 *
 *   1. If the deployment has declared a reverse proxy (`TRUSTED_REVERSE_PROXY`),
 *      the address is the **last** hop of `x-forwarded-for`, not the first. A
 *      reverse proxy appends the address it saw to whatever it was sent
 *      (`$proxy_add_x_forwarded_for` in the nginx this deployment runs), so the
 *      rightmost entry is the one added by the proxy we are behind and everything
 *      to its left is a prefix the client wrote. Reading the first entry — which
 *      is what the control plane did — lets a browser put any address it likes in
 *      the audit trail by sending one extra header, and an audit record is the one
 *      thing that must not be writable by the subject of the audit.
 *   2. Otherwise the forwarded header is ignored completely and the address is
 *      the connection itself. With no proxy in front, a forwarded header can only
 *      have been written by the caller, so there is nothing in it to believe. In
 *      the dev stack this is also the *better* answer: the browser connects to
 *      this process directly, and the socket is then the browser's own address.
 */
export function clientAddressFor(
  forwardedFor: string | string[] | undefined,
  socketAddress: string | undefined,
  options: { trustedReverseProxy: boolean },
): string | null {
  if (options.trustedReverseProxy) {
    const raw = Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? "");
    const hops = raw
      .split(",")
      .map((hop) => normalise(hop.trim()))
      .filter((hop) => hop !== "");

    const nearest = hops.at(-1);
    if (nearest !== undefined) return nearest;
  }

  const socket = normalise((socketAddress ?? "").trim());
  return socket === "" ? null : socket;
}

/**
 * Node reports an IPv4 connection on a dual-stack socket as `::ffff:a.b.c.d`.
 * Recording that spelling in an audit row would make the same address arrive in
 * two forms, which is exactly what a reviewer comparing rows does not want.
 */
function normalise(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}
