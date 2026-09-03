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

## Public ingress (Tailscale Funnel)

Everything above this section makes catamorbius reachable on loopback only
— correct and intentional (see the loopback section up top). Making it
reachable from the public internet, so GitHub and Jira Cloud can actually
deliver webhooks to it, is a separate layer on top, added here.

**Approach: [Tailscale Funnel](https://tailscale.com/kb/1223/tailscale-funnel).**
Chosen over cloudflared/ngrok/caddy/nginx/a container runtime (none of
which are installed on the fleet host, and most of which need a new
account nobody has) and over router port-forwarding (needs the same human
click as Funnel plus a certificate story Funnel gives for free): Tailscale
is already installed, up, and logged in on this host, and Funnel gives a
stable `https://<node>.<tailnet>.ts.net` name with a real Let's Encrypt
certificate, no new binary, no DNS registrar, no router change. Rejecting
this approach — e.g. because the tailnet admin declines to enable Funnel,
or because Funnel turns out unable to pass request bodies byte-for-byte or
to stream SSE without buffering — is a decision for whoever owns the
ingress story, not an implementation detail to route around silently; if
you hit either of those, say so loudly rather than reaching for one of the
rejected alternatives.

### Why 127.0.0.1, not the tailnet address

**Funnel/Serve must be pointed at `127.0.0.1:<PORT>`, never at the host's
own tailnet IP or a bare port that isn't explicitly loopback.** This is not
obvious and costs real time to rediscover: catamorbius binds loopback only
(see above), and *the host's own tailnet-facing address refuses the
connection exactly the same way its LAN address does* — only 127.0.0.1
answers. Point Funnel at the tailnet IP and it will fail to reach the
service, which looks exactly like "the proxy can't reach catamorbius" — a
symptom whose tempting wrong fix is widening the gateway's own bind back
to every interface. **Don't.** `deploy/funnel.sh` (below) always targets
`127.0.0.1:$PORT` explicitly so nobody has to remember this under
pressure; if you ever drive `tailscale funnel`/`tailscale serve` by hand,
target `127.0.0.1:<PORT>` the same way.

### What's committed, and why a script instead of a config file

Funnel's configuration lives in `tailscaled`'s own persistent state, not in
a file this repo can ship — there is no Funnel-equivalent of
`catamorbius.service` to commit. What's committed instead is
[`deploy/funnel.sh`](funnel.sh), an idempotent script with three
subcommands:

```sh
deploy/funnel.sh install [PORT]   # turn Funnel on for 127.0.0.1:PORT (default 3000)
deploy/funnel.sh status           # show current Funnel/Serve config and the public URL, if any
deploy/funnel.sh teardown         # turn Funnel off (does not touch the gateway or its unit)
```

`install` is safe to re-run: it checks the current Funnel config first and
no-ops if the target port is already funneled, rather than erroring or
duplicating config. It also always runs the underlying `tailscale funnel`
call under a `timeout`, for the reason in the next section — never invoke
`tailscale funnel --bg <target>` directly without one.

### Prerequisite: two tailnet-admin settings, neither reachable from an agent account

**Funnel requires two things enabled at the tailnet level, by whoever owns
the tailnet — the `funnel` node capability for this specific node, and
HTTPS certificates for the tailnet.** Neither is something a deploying
account (agent or human operator without tailnet-admin rights) can turn on
itself, even if that account holds `is-owner`/`is-admin` node capabilities
— those describe the *node's* capabilities, not a grant to change tailnet
policy. Check both before assuming Funnel is ready:

```sh
tailscale status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print("CertDomains:", d.get("CertDomains")); print("CapMap:", d.get("Self",{}).get("CapMap"))'
```

`CertDomains: null` and no `funnel` key in `CapMap` both mean it's not
enabled yet.

**What "not enabled" actually looks like when you try it — this is the
expensive-to-rediscover part.** `tailscale funnel --bg <target>` does
**not** fail fast and does **not** return a normal error. It prints this
and then blocks indefinitely, polling for approval:

```
Funnel is not enabled on your tailnet.
To enable, visit:

         https://login.tailscale.com/f/funnel?node=<node-id>
```

Run it under `timeout` and with `</dev/null`, or it hangs whatever invoked
it — `deploy/funnel.sh install` already does both, and on hitting this
wall exits `2` (distinct from `1`, a genuine error) after confirming the
killed attempt left no partial state behind (`tailscale funnel status`
still reports "No serve config"). The one-click enablement URL is
node-specific and emitted by the CLI itself — the tailnet owner visits it
and approves; nothing on this host can complete that flow, and this script
deliberately does not try.

**`tailscale serve` (tailnet-internal only, no public exposure) has an
independent enablement wall of its own** — confirmed live on this host: it
blocks with the identical shape but a different URL
(`https://login.tailscale.com/f/serve?node=<node-id>`), a separate
tailnet-admin switch from Funnel's own, not the same setting phrased
twice. **So there are three tailnet-admin settings involved, not two: the
`funnel` node attribute, HTTPS certificates for the tailnet, and — easy to
miss because the CLI output looks so similar — a separate `serve`
attribute.** This matters because `tailscale serve` was meant to be usable
as a de-risking proxy (proving body passthrough and SSE aren't mangled)
without needing Funnel's public cert — on a tailnet where `serve` isn't
enabled either, that de-risk is blocked right along with Funnel, and has
to wait for all three to be turned on.

**On both commands: the exit code you see is your shell's `timeout`
killing the process, not `tailscale`'s own verdict.** Whether you ran
`tailscale funnel --bg <target>` or `tailscale serve --bg <target>`, an
exit `124` under `timeout N ... </dev/null` means N seconds elapsed while
the command was still polling for approval — it is not `tailscale` itself
reporting failure, and the same wall would keep the command blocked
indefinitely without a `timeout` around it. Read the printed message
("... is not enabled on your tailnet"), not the shell exit code, as the
actual verdict.

### Verifying it worked

```sh
deploy/funnel.sh status
```

should show a `https://<node>.<tailnet>.ts.net` entry proxying to
`127.0.0.1:<PORT>`. Confirm end-to-end with `curl` from a **different**
host than this one — a request that never left the machine proves nothing
about public reachability:

```sh
curl https://<node>.<tailnet>.ts.net/healthz
```

expect catamorbius's real `{"ok":true,"seq":<n>}`.

### Tearing it down

```sh
deploy/funnel.sh teardown
```

turns Funnel off. This only removes the public-ingress config; it does not
touch the gateway process, its systemd unit, its database, or the loopback
bind — those are unaffected by anything in this section.

### Persistence

`tailscale funnel --bg` persists in `tailscaled`'s own state, which is
itself backed by a systemd **system** service (`tailscaled.service`,
separate from catamorbius's own **user** unit) that starts on boot — so
the Funnel config is expected to survive a restart of catamorbius itself,
a restart of `tailscaled`, and a reboot of the host, the same way any
other `tailscale serve`/`funnel` config does. Whichever of those this
project's own evidence trail actually exercises (rather than just cites
this mechanism for) is recorded, separately, wherever that live proof
lives — check there for what was actually measured versus what is
asserted here from Tailscale's own documented behavior.
