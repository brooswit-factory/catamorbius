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

`sudo` is required for the iptables calls and is passwordless for the
deploying account on this fleet's hosts (see the ASSIST Confluence space).
The rule is scoped to exactly this unit's own `$PORT` and is idempotent, so
restarts never stack duplicate rules.

## Install

1. Clone the repo to a stable checkout outside any agent workspace (it must
   survive workspace rebuilds), e.g. `~/deploy/catamorbius`, and run
   `bun install` in it.
2. Pick a stable path for the sqlite log, outside any workspace and outside
   the checkout itself, e.g. `~/.local/share/catamorbius/catamorbius.sqlite`.
   The parent directory must exist; the file is created on first start.
3. Copy `catamorbius.env.example` to a private path, e.g.
   `~/.config/catamorbius/catamorbius.env`, fill in `CATAMORBIUS_DB` and
   strong random secrets (`openssl rand -hex 32`), and `chmod 600` it.
4. Copy `catamorbius.service` to `~/.config/systemd/user/catamorbius.service`.
   It uses `%h` for the home directory, so it works as-is as long as the
   checkout and env file are at the paths you chose above — adjust
   `WorkingDirectory` / `EnvironmentFile` if you chose different ones.
5. `loginctl enable-linger <account>` so the unit starts on boot without a
   login session.
6. `systemctl --user daemon-reload && systemctl --user enable --now catamorbius.service`.
7. Verify: `curl http://localhost:<PORT>/healthz` should return
   `{"ok":true,"seq":<n>}`.

## Deploying a new version

`git pull --ff-only origin main` in the checkout, then
`systemctl --user restart catamorbius.service` — with `XDG_RUNTIME_DIR` set
for that account. Verify the HEAD sha, the package version, and
`GET /healthz` afterwards.

## Logs

`journalctl --user -u catamorbius.service` — note the `--user` flag; the
system-level form silently shows no entries for a user unit.
