#!/usr/bin/env bash
# install.sh — bootstrap the full AI framework stack from git.
#
# Clones mars-framework (beads-orchestration + bead-kanban) and fleet,
# installs the CLIs globally, bootstraps the orchestrator, overlays fleet's
# Claude assets, and launches the kanban UI.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ilies-bel/mars-framework/main/install.sh | bash
#   ./install.sh
#
# Env:
#   INSTALL_ROOT        parent dir for ai-framework/ and fleet/   (default: $HOME/project/perso)
#   GIT_PROTO           https | ssh                               (default: https)
#   SKIP_KANBAN_LAUNCH  set to 1 to skip launching bead-kanban    (default: unset)

set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT:-$HOME/project/perso}"
GIT_PROTO="${GIT_PROTO:-https}"
AIFW="$INSTALL_ROOT/ai-framework"
FLEET="$INSTALL_ROOT/fleet/qa-fleet"

MARS_REPO_HTTPS="https://github.com/ilies-bel/mars-framework.git"
MARS_REPO_SSH="git@github.com:ilies-bel/mars-framework.git"
FLEET_REPO_HTTPS="https://github.com/ilies-bel/fleet.git"
FLEET_REPO_SSH="git@github.com:ilies-bel/fleet.git"

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

case "${1:-}" in
  -h|--help) usage ;;
esac

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

resolve_url() {
  local kind="$1"
  case "$GIT_PROTO:$kind" in
    https:mars)  echo "$MARS_REPO_HTTPS" ;;
    ssh:mars)    echo "$MARS_REPO_SSH" ;;
    https:fleet) echo "$FLEET_REPO_HTTPS" ;;
    ssh:fleet)   echo "$FLEET_REPO_SSH" ;;
    *) die "unknown GIT_PROTO=$GIT_PROTO (expected 'https' or 'ssh')" ;;
  esac
}

clone_or_update() {
  local target="$1" url="$2"
  if [ -d "$target/.git" ]; then
    log "updating $target"
    git -C "$target" pull --ff-only
  elif [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null || true)" ]; then
    die "$target exists and is not a git checkout. Remove it or set INSTALL_ROOT to a different path."
  else
    log "cloning $url -> $target"
    mkdir -p "$(dirname "$target")"
    git clone "$url" "$target"
  fi
}

# 1. preflight
log "preflight"
for cmd in git npm node; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required but not installed"
done

if ! command -v rtk >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || die "rtk missing and brew not available to install it"
  HOMEBREW_NO_AUTO_UPDATE=1 brew install rtk
fi

NPM_PREFIX="$(npm prefix -g)"
if [ ! -w "$NPM_PREFIX" ]; then
  log "npm prefix $NPM_PREFIX not writable; rerouting to \$HOME/.npm-global"
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
fi

# 2. clone / update
clone_or_update "$AIFW"  "$(resolve_url mars)"
clone_or_update "$FLEET" "$(resolve_url fleet)"

# 3. npm installs
log "installing beads-orchestration (npm -g $AIFW/The-Claude-Protocol)"
npm install -g "$AIFW/The-Claude-Protocol"

log "installing bead-kanban (npm -g $AIFW/kanban/npm)"
npm install -g "$AIFW/kanban/npm"

log "installing fleet (npm -g $FLEET)"
npm install -g "$FLEET"

for bin in beads-orchestration bead-kanban fleet rtk; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin did not land on PATH after install"
done

# 3b. portable timeout shim (macOS ships without GNU coreutils timeout)
TMPBIN="$(mktemp -d)/bin"; mkdir -p "$TMPBIN"
if ! command -v timeout >/dev/null 2>&1; then
  log "timeout not found on PATH — installing perl-based shim at $TMPBIN/timeout"
  cat >"$TMPBIN/timeout" <<'SHIM'
#!/bin/sh
s=$1; shift
exec perl -e '$SIG{ALRM}=sub{exit 124}; alarm shift; exec @ARGV' "$s" "$@"
SHIM
  chmod +x "$TMPBIN/timeout"
  export PATH="$TMPBIN:$PATH"
fi
log "setting BEADS_HOOK_TIMEOUT=30 (prevents bd init lock on macOS)"
export BEADS_HOOK_TIMEOUT=30

# 4. orchestrator bootstrap
log "beads-orchestration setup --project-dir $AIFW"
beads-orchestration setup --project-dir "$AIFW"

# 5. fleet claude overlay (must run after step 4 so fleet's supervisors win)
log "overlaying fleet Claude assets (using local fleet CLI from step 3)"
(cd "$AIFW" && fleet install-claude --local --force)

# 6. kanban launch
if [ "${SKIP_KANBAN_LAUNCH:-}" = "1" ]; then
  log "SKIP_KANBAN_LAUNCH=1 — not starting bead-kanban"
elif pgrep -f "bead-kanban" >/dev/null 2>&1; then
  log "bead-kanban already running"
else
  log "starting bead-kanban (log: /tmp/bead-kanban.log)"
  nohup bead-kanban >/tmp/bead-kanban.log 2>&1 &
  disown || true
fi

# 7. summary + next step
cat <<EOF

INSTALL COMPLETE
  ai-framework:        $AIFW
  fleet:               $FLEET
  rtk:                 $(command -v rtk)
  beads-orchestration: $(command -v beads-orchestration)
  bead-kanban:         $(command -v bead-kanban)
  fleet CLI:           $(command -v fleet)
  kanban UI:           http://localhost:3008

Next (Claude-only step):
  Open Claude Code in $AIFW and run /install-stack, or ask Claude to dispatch the
  'discovery' subagent with this prompt so that .claude/agents/qa-supervisor.md
  gets generated:

    BEAD_ID: bootstrap-discovery

    Run full discovery in $AIFW. The sibling path ../fleet/qa-fleet/ EXISTS —
    you MUST emit .claude/agents/qa-supervisor.md per Step 3.6 of your
    instructions (Quinn, QA supervisor, references fleet-manager skill).
    Do NOT ask questions. Write all supervisors and then report.
EOF
