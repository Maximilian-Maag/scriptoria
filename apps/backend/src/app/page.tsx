export default function ControlPlanePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: "42rem" }}>
      <h1>Scriptoria — Control Plane</h1>
      <p>
        This is the API tier. Every privileged operation lives here: authentication against the
        directory, authorisation against the area mapping, the run lifecycle, results, schedules
        and the audit trail.
      </p>
      <p>
        The user interface is a separate application. The terminal WebSocket is mounted on this
        app&rsquo;s custom server rather than on a route handler, because a route handler cannot
        hold a socket open for the life of a run.
      </p>
      <ul>
        <li>
          <a href="/api/health">/api/health</a> — liveness and dependency checks
        </li>
        <li>
          <a href="/api/docs">/api/docs</a> — the REST contract
        </li>
      </ul>
    </main>
  );
}
