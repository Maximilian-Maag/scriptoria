# The script VM

What the platform expects of the machine the scripts live on, what it does there, and what it
never does. Written for the person who owns that machine — usually the same person who owns the
scripts — because the platform's whole claim is that it *installs nothing and assumes nothing*
(NFR-07), and that only holds if both sides know exactly what the boundary is.

The fixture in `infra/sshd` is a worked example of everything below: an account, a script
directory, an output directory and a crontab, running in a container. It proves the mechanism.
It does not stand in for a real environment, and this page is the difference.

## What the platform does on that machine

Three things, all over SSH, all as one account:

| It does | How |
|---|---|
| Reads the script directory to build the catalog | lists the directory and reads the first 100 lines of each file (ADR-004) |
| Runs a script, when somebody starts it | one SSH session, one PTY, stdin/stdout/stderr streamed both ways (ADR-001, ADR-006) |
| Lists and reads files in the output directory | `stat`, then the file over SFTP when somebody opens or downloads it (FA-09) |
| Reads and writes the account's crontab | `crontab -l` / `crontab -`, only between its own delimiters (ADR-005) |

It installs no agent, opens no port, holds no credentials of yours, and runs no scheduler. It
never deletes anything on the machine, and it does not modify your scripts.

## The account

One account per script VM, the one that owns the scripts. The platform never logs in as root and
never has a second account.

The runner's public key goes into that account's `authorized_keys`. Two properties are worth
checking by hand rather than assuming, because both fail as `Permission denied (publickey)`,
which sends people to look at the key instead of the file:

- the file is **owned by the account**, not by whoever copied it in (a bind mount or a `sudo cp`
  leaves root's ownership, and `StrictModes` then refuses it);
- its directory is mode `700` and the file `600`.

```sh
# as the account's owner
install -d -m 700 ~/.ssh
install -m 600 /path/to/runner_id_ed25519.pub ~/.ssh/authorized_keys
ls -la ~/.ssh                    # owner = the account, .ssh 700, authorized_keys 600
```

The account's shell does not matter: the platform opens a PTY and runs the script's path
directly, so the shebang decides the interpreter.

## The scripts

- **Executable, with a shebang.** `chmod +x`, and the first line names the interpreter. A script
  the catalog lists but cannot execute is shown, and starting it fails in the terminal with the
  shell's own message — which is the correct place for it to fail.
- **Their own environment.** The platform activates nothing, exports nothing and assumes nothing
  about interpreters, virtual environments, credentials or site lists. A script that needs a venv
  creates or activates it itself (NFR-21); a script that needs an SSH key or an API token keeps it
  where it always kept it.
- **A header block**, in the existing header comment, inside the first 100 lines (ADR-004):

```bash
#!/usr/bin/env bash
# scriptoria:title        Interface inventory across all sites
# scriptoria:description  Reads the interface configuration of every device in the
#                         branch network and writes one workbook per site.
# scriptoria:criticality  read-only          # read-only | modifying
# scriptoria:interactive  false              # prompts on stdin?
# scriptoria:outputs      /opt/scriptoria/export
```

Every key is optional, and an absent or unreadable block never keeps a script out of the
catalog — it is shown as *undeclared*. **`criticality` is the one to get right**: it decides
whether the interface warns about a modifying run, and whether stopping it asks for a
confirmation that names the script. The default when nothing declares it is `modifying`, because
the cost of wrongly warning is a click and the cost of the reverse is an unannounced change to
every system the script touches. A stored override in the platform wins over the header, so a
script can be corrected without editing it on a production VM.

`docs/guides/examples/reference-script.sh` is a copy-me template that declares all of this; it is
parsed by the platform's own header parser in a test, so it cannot drift.

## The output directory

The platform shows what a run *left behind*: it lists the output directory after the script ends
and treats files modified at or after the run's start as that run's results.

- Write results **under** the declared directory. A per-run or per-date subdirectory is the
  natural shape (the fixtures use `<outputs>/<YYYY-MM-DD>`), and it is what makes "new files"
  unambiguous.
- Results stay where they are. The platform lists and streams; it never moves or deletes, so a
  file the script keeps and a file a run produced are the same file (FA-09.3).
- A large output is streamed on request and capped per file (`MAX_PREVIEW_BYTES` for a preview,
  the whole file for a download), so a 2 GB log is downloadable but not previewable.

## Interaction

- stdin, stdout and stderr are a **real PTY**, so a prompt behaves the way it does in a terminal:
  it blocks, it can be answered, and it can be interrupted (FA-06).
- Prompts should be **plain lines**. The live view is xterm.js and renders ANSI colour and cursor
  movement, but the durable copy of a finished run is the byte stream (FA-07.2, ADR-006): a
  full-screen TUI replays as everything it ever drew, not as its final screen. Line-oriented
  output survives both.
- Nothing is answered for the operator. A script that prompts simply waits.

## Stopping

Stopping is staged (ADR-003): `SIGINT` to the **process group** first, then `SIGTERM`, then
`SIGKILL`, with a pause between the stages; for a `modifying` script the interface asks for the
script's name first and records who stopped it. The grace periods are deployment configuration
(`ABORT_SIGINT_GRACE_MS`, `ABORT_SIGTERM_GRACE_MS`).

What the script owner should know: **the platform cannot roll anything back.** A script stopped
partway through hundreds of sites is partway through hundreds of sites (NFR-06). A `trap` on
`INT`/`TERM` that finishes the current item and exits non-zero is the only unwinding that
happens.

Exit codes are recorded as they are: `0` is *succeeded*, anything else *failed* with its code,
and a run killed by a signal is recorded with the stage the escalation reached. A script that
means "the work is done" should say `exit 0`, and one that means "the work was not done" must not.

## Recurring scripts

The crontab on the script VM stays authoritative (ADR-005). The platform reads it with
`crontab -l`, shows what it finds, and when an administrator edits a schedule writes the file
back with `crontab -` — changing **only** the lines between its two delimiters:

```
# >>> scriptoria managed — do not edit inside this block by hand >>>
0 2 * * * /opt/scriptoria/scripts/inventory-report.sh >> /opt/scriptoria/export/cron-inventory.log 2>&1
# <<< scriptoria managed <<<
```

Everything outside that block is preserved byte for byte, comments and spacing included. So:
keep hand-written entries outside the block, and expect anything *inside* it to be replaced.

The platform runs no scheduler of its own and does not alert on a scheduled run (NFR-16): the
external monitoring system already watches them.

## Checklist before pointing the platform at a machine

Run this as the account, on the script VM. Each line is a property the platform relies on.

```sh
whoami                                        # the account the platform was given
ls -ld ~/.ssh                                 # drwx------ you you
ls -l ~/.ssh/authorized_keys                  # -rw------- you you, and it contains the runner's key
ls -l /opt/scriptoria/scripts/*.sh            # -rwxr-xr-x: executable, shebang on line 1
head -20 /opt/scriptoria/scripts/<a-script>    # the scriptoria: header block
ls -ld /opt/scriptoria/export                 # writable by this account
crontab -l                                    # what the platform will read
```

Then start the smallest script from the platform and check three things: the terminal shows what
the script printed, the run ends with the exit code the script meant, and the files the script
wrote appear under **Results**.

## What the platform team needs from the machine's owner

The half of O-6 that only the owner can supply:

1. the address the runner reaches (inside the network, not a public one),
2. the account, and the runner's public key installed for it,
3. the script directory and the output directory,
4. one real script, annotated with the header block, that is safe to run twice,
5. confirmation that the platform may read and write **that account's** crontab.
