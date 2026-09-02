# Deploying catamorbius

Runs as a systemd **user** unit under a house account, following this
fleet's standard deploy pattern (see the ASSIST Confluence space, "The
fleet: machines, identities and how a deploy is done"). Localhost-only —
making it reachable beyond that is a separate, later story.

The gateway binds loopback itself via the `HOST` env var (see the README's
Configuration table). It is set in two places on purpose: the unit
(`deploy/catamorbius.service`) sets `Environment=HOST=127.0.0.1` as a
fallback default, and `catamorbius.env.example` also ships `HOST=127.0.0.1`
— **the env file is what actually decides it**, since systemd's
`EnvironmentFile=` overrides the unit's own `Environment=` for the same
variable whichever order the two directives appear in (this is not the
order-dependent override you might expect from reading the unit file top to
bottom — verify it yourself before relying on it). Don't remove or change
the `HOST` line in your env file without understanding that consequence:
there is no firewall rule behind it to catch a mistake. No firewall rule,
and no `sudo`, are involved in keeping this localhost-only.

**Verifying "not LAN-reachable": `curl http://<host's LAN-facing
IP>:<PORT>/healthz` should get connection refused (curl exit `7`) — nothing
is listening on that address. That is success.** Earlier deployments of
this service (before the gateway had a bind-address variable) instead kept
the LAN out with a source-address iptables `DROP` rule installed and torn
down around the process's lifetime, which produced a *timeout* on the same
command (curl exit `28`) instead — a different signature for the same "not
LAN-reachable" outcome. That mechanism is gone; if you are comparing
against an older runbook or an older host, don't read today's exit `7` as
a regression from that exit `28` — it's the more direct proof, and the
DROP rule is no longer in the picture at all.

Two dead ends worth keeping on record — both confirmed live in this
project's history, both expensive to rediscover, neither a reason to bring
back a firewall-based approach:

- systemd's own `IPAddressAllow`/`IPAddressDeny` sandboxing is a silent
  no-op for an unprivileged *user* unit: it logs "unit configures an IP
  firewall, but not running as root" and installs nothing.
- An interface-based rule (`! -i lo`) never fires: the kernel delivers a
  host's own LAN-IP-directed traffic over `lo` regardless of destination
  address, even though on the wire it's indistinguishable from a real
  external client's. Only a source-address rule (or, as now, actually
  binding the right interface) works.

## Install

1. Clone the repo to a stable checkout outside any agent workspace (it must
   survive workspace rebuilds), e.g. `/home/<account>/deploy/catamorbius`,
   and run `bun install` in it.
2. Pick a stable path for the sqlite log, outside any workspace and outside
   the checkout itself, e.g.
   `/home/<account>/.local/share/catamorbius/catamorbius.sqlite`. The
   parent directory must exist; the file is created on first start.
3. Copy `catamorbius.env.example` to a private path, e.g.
   `/home/<account>/.config/catamorbius/catamorbius.env`, fill in
   `CATAMORBIUS_DB` and strong random secrets (`openssl rand -hex 32`), and
   `chmod 600` it. Leave `HOST=127.0.0.1` as shipped — see above for why
   that line, not the unit, is what actually decides the bind address.
4. Copy `catamorbius.service` to
   `/home/<account>/.config/systemd/user/catamorbius.service`. It uses `%h`
   for the home directory, so it works as-is as long as the checkout and
   env file are at the paths you chose above — adjust `WorkingDirectory` /
   `EnvironmentFile` if you chose different ones.
5. `loginctl enable-linger <account>` so the unit starts on boot without a
   login session.
6. `systemctl --user daemon-reload && systemctl --user enable --now catamorbius.service`.
7. Verify: `curl http://localhost:<PORT>/healthz` should return
   `{"ok":true,"seq":<n>}`.

**Record, for whoever deploys this next: the host, the owning account, and
the absolute paths chosen in steps 1-3** (not `~`-relative — `~` resolves
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
