# Deploying catamorbius

Runs as a systemd **user** unit under a house account, following this
fleet's standard deploy pattern (see the ASSIST Confluence space, "The
fleet: machines, identities and how a deploy is done"). Localhost-only —
making it reachable beyond that is a separate, later story.

The app itself has no `HOST`/bind-address env var (checked `src/config.ts`
and `src/index.ts` at this commit) — it always binds every interface, so
deploying just the app is reachable from the LAN, not just localhost —
confirmed on the host this was built on. What actually keeps this
localhost-only is the unit's `ExecStartPre`/`ExecStopPost` pair, which
installs (and tears down) a source-address iptables rule around the
process's lifetime: `-p tcp --dport <PORT> ! -s 127.0.0.1 -j DROP`. Two
things that look like they'd work here do NOT, both confirmed live on this
host:

- systemd's own `IPAddressAllow=localhost` / `IPAddressDeny=any` sandboxing
  is a silent no-op for a *user* unit running unprivileged (systemd logs
  "unit configures an IP firewall, but not running as root" and installs
  nothing) — the LAN could still reach the port with it set.
- An interface-based rule (`! -i lo -j DROP`) also does not work: a request
  this same host sends to its own LAN-facing IP is delivered over `lo`
  internally by the kernel regardless of destination address, so `-i lo`
  matches it and the rule never fires — even though, on the wire, that
  traffic is indistinguishable from a real external client's. The
  source-address form is what actually blocks it.

**This whole iptables/sudo mechanism is an interim measure, not the settled
end state.** It exists only because the gateway itself has no bind-address
variable to restrict which interface it listens on. **CATA-8** tracks
adding that variable and, once it lands, *removing* this unit's
`ExecStartPre`/`ExecStopPost`/sudo machinery in favor of the gateway
binding loopback directly — at which point this whole section goes away.
Until then, the sudo dependency below counts as a real hit against
"reproducible by someone who is not the original deployer": don't treat it
as fully solved.

The `sudo` calls in the unit need a NOPASSWD sudoers entry for the deploying
account — see Install step 1 below, which is a **prerequisite of this
deployment**, not a claim about every host in the fleet. `ExecStartPre` has
no `-` prefix on purpose: if that sudoers entry is missing, the unit fails
to start rather than starting wide-open on the LAN. If you see the service
fail to start (including on boot), check this first — `journalctl --user -u
catamorbius.service` will show the `sudo` failure. The rule itself is
scoped to exactly this unit's own `$PORT` and is idempotent, so restarts
never stack duplicate rules.

## Install

1. Grant the deploying account passwordless sudo for exactly the iptables
   calls this unit makes, scoped to the port you're about to choose in step
   3 (`3000` below — replace it with your actual port in all three lines).
   Add a file under `/etc/sudoers.d/` (`visudo -f
   /etc/sudoers.d/catamorbius`) containing:
   ```
   <account> ALL=(root) NOPASSWD: /usr/sbin/iptables -C INPUT -p tcp --dport 3000 ! -s 127.0.0.1 -j DROP, /usr/sbin/iptables -I INPUT -p tcp --dport 3000 ! -s 127.0.0.1 -j DROP, /usr/sbin/iptables -D INPUT -p tcp --dport 3000 ! -s 127.0.0.1 -j DROP
   ```
   without this, the unit still fails closed (see above) rather than
   silently exposing the port — but it also won't start at all.
2. Clone the repo to a stable checkout outside any agent workspace (it must
   survive workspace rebuilds), e.g. `/home/<account>/deploy/catamorbius`,
   and run `bun install` in it.
3. Pick a stable path for the sqlite log, outside any workspace and outside
   the checkout itself, e.g.
   `/home/<account>/.local/share/catamorbius/catamorbius.sqlite`. The
   parent directory must exist; the file is created on first start.
4. Copy `catamorbius.env.example` to a private path, e.g.
   `/home/<account>/.config/catamorbius/catamorbius.env`, fill in
   `CATAMORBIUS_DB` and strong random secrets (`openssl rand -hex 32`), and
   `chmod 600` it.
5. Copy `catamorbius.service` to
   `/home/<account>/.config/systemd/user/catamorbius.service`. It uses `%h`
   for the home directory, so it works as-is as long as the checkout and
   env file are at the paths you chose above — adjust `WorkingDirectory` /
   `EnvironmentFile` if you chose different ones.
6. `loginctl enable-linger <account>` so the unit starts on boot without a
   login session.
7. `systemctl --user daemon-reload && systemctl --user enable --now catamorbius.service`.
8. Verify: `curl http://localhost:<PORT>/healthz` should return
   `{"ok":true,"seq":<n>}`.

**Record, for whoever deploys this next: the host, the owning account, and
the absolute paths chosen in steps 2-4** (not `~`-relative — `~` resolves
to whichever account reads it, not the one that ran the install). Those
four facts are what makes this deployment findable; without them a
successor with shell access to the very same host cannot locate the unit,
the checkout, the database, or the env file that later stories need to
sign deliveries and subscribe.

## Deploying a new version

`git pull --ff-only origin main` in the checkout, then
`systemctl --user restart catamorbius.service` — with `XDG_RUNTIME_DIR` set
for that account. Verify the HEAD sha, the package version, and
`GET /healthz` afterwards.

## Logs

`journalctl --user -u catamorbius.service` — note the `--user` flag; the
system-level form silently shows no entries for a user unit.
