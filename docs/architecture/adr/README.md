# Architecture Decision Records

One file per decision that was not obvious and would otherwise be re-litigated. The model in
`../workspace.dsl` shows *what* was built; these say *why*, and what was rejected.

| ADR | Decision | Status |
|---|---|---|
| [001](001-ssh-pty-instead-of-per-vm-agent.md) | Execute scripts over outbound SSH with a PTY, not through an agent on each script VM | Accepted |
| [002](002-one-typescript-monorepo.md) | One TypeScript monorepo, Next.js on both web tiers | Accepted |
| [003](003-staged-abort-by-criticality.md) | Staged abort signalled to the process group, gated on the script's criticality | Proposed |
| [004](004-script-metadata-header.md) | A script declares its own metadata in a header block, with an admin override as fallback | Proposed |
| [005](005-crontab-stays-authoritative.md) | The crontab on the script VM stays authoritative; the platform runs no scheduler | Accepted |
| [006](006-terminal-transport.md) | Terminal bytes travel through a capped Redis stream and binary WebSocket frames | Accepted |
| [007](007-nextjs-custom-server-for-the-terminal.md) | The backend runs a custom Next.js server so the terminal can use a real WebSocket | Accepted |
| [008](008-the-audit-log-is-the-root-accounts.md) | The audit log is the root account's, and reading it is not audited | Proposed |
| [009](009-generated-rest-contract-without-a-renderer.md) | The REST contract is generated from the schemas, and its page ships no renderer | Accepted |
| [010](010-the-images-ship-typescript.md) | The images ship TypeScript and run it through tsx | Accepted |
