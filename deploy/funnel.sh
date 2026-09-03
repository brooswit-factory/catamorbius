#!/usr/bin/env bash
# deploy/funnel.sh — install, check, or tear down the Tailscale Funnel
# ingress in front of catamorbius. Read deploy/README.md's "Public ingress"
# section first; this script is the "what is committed" half of that
# section, since Funnel's own config lives in tailscaled's state, not a
# file this repo can ship.
#
# Usage:
#   deploy/funnel.sh install [PORT]   # idempotent: turn Funnel on for PORT (default 3000)
#   deploy/funnel.sh status           # show current Funnel config and the public URL, if any
#   deploy/funnel.sh teardown         # turn Funnel off (does not touch the gateway or its unit)
#
# PORT defaults to 3000 (catamorbius's own default) and can be overridden by
# a PORT env var or a positional argument to `install` — this script does
# not read the deployment's env file itself, so it never needs to run as
# (or read secrets belonging to) the account that owns the deployment,
# though in practice they're usually the same account.
#
# ALWAYS targets 127.0.0.1:$PORT explicitly, never a bare port number and
# never the tailnet address. This matters because catamorbius binds
# loopback ONLY (see the "why 127.0.0.1 and not the tailnet IP" note in
# deploy/README.md) — the host's own tailnet IP refuses the connection
# exactly like its LAN IP does, so pointing Funnel at anything but
# 127.0.0.1 makes it look like "the proxy can't reach the service", and the
# tempting wrong fix is widening the gateway's own bind. Don't do that;
# fix the Funnel target instead — it's this script's job to always get
# that right so nobody has to remember it under pressure.

set -euo pipefail

PORT="${2:-${PORT:-3000}}"
TARGET="127.0.0.1:${PORT}"

usage() {
  echo "usage: $0 {install|status|teardown} [PORT]" >&2
  exit 64
}

require_tailscale_up() {
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "ERROR: tailscale CLI not found on PATH." >&2
    exit 1
  fi
  local backend
  backend="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["BackendState"])' 2>/dev/null || echo "unknown")"
  if [ "$backend" != "Running" ]; then
    echo "ERROR: tailscaled BackendState is '$backend', not 'Running'. Funnel needs a logged-in, running tailscaled first." >&2
    exit 1
  fi
}

do_status() {
  echo "--- tailscale funnel status ---"
  tailscale funnel status
  echo
  echo "--- tailscale serve status ---"
  tailscale serve status
}

already_funneled() {
  # True (exit 0) iff funnel status already mentions our target port.
  tailscale funnel status 2>/dev/null | grep -q ":${PORT}[[:space:]]" 2>/dev/null || \
    tailscale funnel status 2>/dev/null | grep -q "127.0.0.1:${PORT}"
}

do_install() {
  require_tailscale_up

  if already_funneled; then
    echo "Funnel already configured for port ${PORT} — idempotent no-op. Current state:"
    do_status
    exit 0
  fi

  echo "Enabling Funnel for ${TARGET} (background, persists in tailscaled state)..."
  local out rc
  set +e
  out="$(timeout 10 tailscale funnel --bg "$TARGET" </dev/null 2>&1)"
  rc=$?
  set -e

  if [ $rc -eq 0 ]; then
    echo "$out"
    echo
    echo "Funnel installed. Verifying:"
    do_status
    exit 0
  fi

  if [ $rc -eq 124 ] || printf '%s' "$out" | grep -q "not enabled on your tailnet"; then
    echo "BLOCKED: Funnel is not enabled on this tailnet yet. This is the expected" >&2
    echo "failure mode when the tailnet-level 'funnel' node attribute and/or HTTPS" >&2
    echo "certificates haven't been turned on by the tailnet admin — see" >&2
    echo "deploy/README.md's 'Public ingress' section. It does NOT fail fast; it" >&2
    echo "blocks polling for approval, which is why this script always runs it" >&2
    echo "under 'timeout' rather than letting it hang." >&2
    echo >&2
    echo "Raw output from the attempt:" >&2
    printf '%s\n' "$out" >&2
    echo >&2
    echo "Confirming no partial state was left behind by the killed attempt:" >&2
    do_status
    exit 2
  fi

  echo "ERROR: 'tailscale funnel' failed for an unrecognized reason (exit $rc):" >&2
  printf '%s\n' "$out" >&2
  exit 1
}

do_teardown() {
  echo "Tearing down Funnel config (gateway and its systemd unit are untouched)..."
  tailscale funnel --https=443 off "$TARGET" 2>/dev/null || tailscale funnel reset
  echo "Verifying:"
  do_status
}

case "${1:-}" in
  install) do_install ;;
  status) do_status ;;
  teardown) do_teardown ;;
  *) usage ;;
esac
