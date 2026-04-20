---
description: Non-interactive install of rtk, bead-orchestrator, kanban-ui, and fleet; bootstrap the orchestrator and generate supervisors in the CURRENT WORKING DIRECTORY, including a QA supervisor keyed on the project's .fleet/fleet.toml (fleet source lives in $HOME/.cache/ai-framework/fleet).
allowed-tools: Bash, Task, Read, Glob
---

Execute the following phases in order. Do NOT ask the user any questions. Run each Bash block in a single tool call; run the discovery dispatch in Phase 4 as a Task call (not bash).

All phases install INTO the directory where this command was invoked (captured as `$TARGET`). Sources are cloned fresh from GitHub into `$HOME/.cache/ai-framework/` on every run, so no pre-existing local checkouts are required.

---

## Phase 0 — environment + source clone

```bash
set -e
TARGET="$(pwd)"
CACHE="$HOME/.cache/ai-framework"
MF_DIR="$CACHE/mars-framework"
FLEET_DIR="$CACHE/fleet"
AIFW="$MF_DIR"
FLEET="$FLEET_DIR"

echo "TARGET project: $TARGET"
echo "CACHE dir:      $CACHE"

command -v git >/dev/null 2>&1 || { echo "git required"; exit 1; }
command -v rtk >/dev/null 2>&1 || brew install rtk
command -v npm >/dev/null 2>&1 || { echo "npm required"; exit 1; }

mkdir -p "$CACHE"

clone_or_update() {
  local url="$1" dest="$2"
  if [ -d "$dest/.git" ]; then
    echo "refreshing $dest"
    git -C "$dest" fetch --quiet origin
    git -C "$dest" reset --quiet --hard origin/HEAD
  else
    echo "cloning $url -> $dest"
    git clone --depth 1 "$url" "$dest"
  fi
}

clone_or_update https://github.com/ilies-bel/mars-framework.git "$MF_DIR"
clone_or_update https://github.com/ilies-bel/fleet.git          "$FLEET_DIR"

[ -d "$AIFW/The-Claude-Protocol" ] || { echo "missing $AIFW/The-Claude-Protocol after clone"; exit 1; }
[ -d "$AIFW/kanban" ]              || { echo "missing $AIFW/kanban after clone"; exit 1; }
[ -f "$FLEET/package.json" ]       || { echo "missing $FLEET/package.json after clone (expected @ilies-bel/fleet repo root)"; exit 1; }

NPM_PREFIX=$(npm prefix -g)
if [ ! -w "$NPM_PREFIX" ]; then
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
  echo "npm prefix rerouted to $HOME/.npm-global"
fi

echo "rtk: $(command -v rtk)"
echo "npm prefix: $(npm prefix -g)"
```

---

## Phase 1 — install CLIs from the cache clones

The monorepo's `kanban/` subdir is v0.3.1 and has no `bin` field, so a plain `npm install -g` from git will not register a working `bead-kanban` CLI. After the git install, if `bead-kanban` is not on PATH, fall back to the npm registry (v0.4.2 ships a prebuilt binary).

```bash
set -e
CACHE="$HOME/.cache/ai-framework"
AIFW="$CACHE/mars-framework"
FLEET="$CACHE/fleet"

npm install -g "$AIFW/The-Claude-Protocol"
npm install -g "$AIFW/kanban" || true
npm install -g "$FLEET"

if ! command -v bead-kanban >/dev/null 2>&1; then
  echo "bead-kanban not registered from git clone (expected — v0.3.1 has no bin). Falling back to npm registry."
  npm install -g beads-kanban-ui@latest
fi

command -v beads-orchestration
command -v bead-kanban
command -v fleet
```

---

## Phase 2 — orchestrator bootstrap (writes into $TARGET)

The `beads-orchestration setup` CLI passes `--claude-only` to `bootstrap.py`, which that script does not accept. Invoke `bootstrap.py` directly to bypass that bug; kanban-ui support is enabled explicitly with `--with-kanban-ui`.

```bash
set -e
TARGET="$(pwd)"
AIFW="$HOME/.cache/ai-framework/mars-framework"

# Copy the create-beads-orchestration skill to ~/.claude/skills/
node "$AIFW/The-Claude-Protocol/scripts/postinstall.js"

# Run bootstrap against $TARGET with kanban support
python3 "$AIFW/The-Claude-Protocol/bootstrap.py" \
  --project-dir "$TARGET" \
  --with-kanban-ui
```

Writes into `$TARGET`:
- `.claude/agents/` (scout, detective, architect, scribe, discovery, code-reviewer, merge-supervisor)
- `.claude/hooks/`, `.claude/settings.json`
- `.claude/beads-workflow-injection.md`, `ui-constraints.md`, `frontend-reviews-requirement.md`, `CLAUDE.md`
- `.beads/` (Dolt config, kanban.json, memory/)

---

## Phase 3 — wire fleet Claude assets

The `@ilies-bel/fleet` npm package is not on the public registry. Use the locally-installed `fleet` CLI (from Phase 1) to run `install-claude` against `$TARGET`.

`--force` is required: without it, `install-claude` prints `skipped (exists)` for every file the orchestrator bootstrap (Phase 2) already wrote (architect, code-reviewer, detective, discovery, merge-supervisor, scout, scribe, subagents-discipline, react-best-practices). Fleet's infra-/react-/node-supervisors that know about the Docker gateway would never land. With `--force`, fleet's versions genuinely overwrite the orchestrator's stubs.

```bash
set -e
TARGET="$(pwd)"
cd "$TARGET"
fleet install-claude --local --force
```

Merges fleet's `infra-supervisor.md`, `react-supervisor.md`, `node-backend-supervisor.md`, the `fleet-manager` skill, and `/fleet:init` + `/fleet:add` commands into `$TARGET/.claude/`. Run AFTER Phase 2 so fleet's versions overwrite the orchestrator's stubs.

---

## Phase 3.5 — bootstrap fleet infrastructure (non-TTY `fleet init`)

The fleet CLI's interactive wizard requires `/dev/tty`. Its source (`cli/cmd-init.sh:421`) hard-errors with `.fleet/fleet.toml not found and no terminal available for interactive setup` the moment it's launched from an automated harness — and there is no `--yes` flag (fleet init takes no arguments; `cmd-init.sh:14-25`).

The automation escape hatch is documented inside the CLI itself: **pre-create `.fleet/fleet.toml`**, then `fleet init` takes the "reconfigure idempotently" branch (`cmd-init.sh:372`), skips the wizard entirely, and runs the Docker-infra bootstrap non-interactively. `ask_yn` calls further down (`cmd-init.sh:54-58`) already auto-answer "y" when no TTY is attached, so downstream prompts degrade safely.

This phase seeds a minimal TOML with project name + root + default ports **unconditionally** (the file is the discovery signal the Phase 4 `discovery` agent keys on to emit `qa-supervisor.md`, so it must exist even on hosts without Docker). Services are left empty on purpose — the user adds `[[services]]` entries after install (see `$HOME/.cache/ai-framework/fleet/.fleet/fleet.toml.example` for the schema). Only the `fleet init` Docker-infra bootstrap is gated on Docker availability.

```bash
set -e
TARGET="$(pwd)"
cd "$TARGET"

# Seed .fleet/fleet.toml unconditionally — required by discovery (Phase 4) to emit qa-supervisor.
if [ ! -f .fleet/fleet.toml ]; then
  mkdir -p .fleet
  DEFAULT_NAME=$(basename "$TARGET" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g')
  cat > .fleet/fleet.toml <<EOF
# Seeded by install-stack (non-interactive). Add [[services]] entries as needed;
# see \$HOME/.cache/ai-framework/fleet/.fleet/fleet.toml.example for the schema.
[project]
name = "$DEFAULT_NAME"
root = "$TARGET"
worktree_template = ".worktrees/{name}"

[ports]
proxy = 3000
admin = 4000
db    = 5432
EOF
  echo "seeded minimal $TARGET/.fleet/fleet.toml"
else
  echo "$TARGET/.fleet/fleet.toml already present — leaving as-is"
fi

# Run fleet init only if Docker is usable; the toml already exists either way.
if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found — skipping fleet init (install Docker and run 'fleet init' later)"
elif ! docker info >/dev/null 2>&1; then
  echo "docker daemon not running — skipping fleet init (start Docker and run 'fleet init' later)"
else
  echo "=== Running fleet init in $TARGET (non-interactive) ==="
  if ! fleet init </dev/null 2>/tmp/fleet-init.err; then
    echo "fleet init failed — see /tmp/fleet-init.err"
    cat /tmp/fleet-init.err || true
  fi
fi

ls -la .fleet/
```

Manual equivalent (if running by hand without a TTY):

```bash
# 1. seed a fleet.toml
cp "$HOME/.cache/ai-framework/fleet/.fleet/fleet.toml.example" .fleet/fleet.toml
# edit .fleet/fleet.toml: set project.name, project.root, and [[services]] entries

# 2. run fleet init with stdin detached
fleet init </dev/null
```

---

## Phase 4 — orchestrator run #2 (supervisor generation)

Fleet lives in the user-level cache at `$HOME/.cache/ai-framework/fleet` and is surfaced to the project via the `fleet` CLI (Phase 1) + `.fleet/fleet.toml` (Phase 3.5). No sibling/parent-folder symlink is created — the discovery agent keys on `.fleet/fleet.toml` inside `$TARGET`.

Dispatch the `discovery` subagent as a Task call (NOT bash). Substitute `<TARGET>` with the absolute path printed in Phase 0 (the current working directory). Use this exact prompt template:

> BEAD_ID: bootstrap-discovery
>
> Run full discovery in `<TARGET>`. If `<TARGET>/.fleet/fleet.toml` EXISTS, you MUST emit `.claude/agents/qa-supervisor.md` per Step 3.6 of your instructions (Quinn, QA supervisor, references fleet-manager skill). Do NOT ask questions. Write all supervisors into `<TARGET>/.claude/agents/` and then report.

The patched discovery agent (Step 3.6) will detect `.fleet/fleet.toml` in `<TARGET>` (seeded by Phase 3.5) and generate `qa-supervisor.md` alongside the tech-stack supervisors.

---

## Phase 5 — verify and launch kanban UI

```bash
set -e
TARGET="$(pwd)"
cd "$TARGET"

echo "=== CLIs on PATH ==="
which rtk beads-orchestration bead-kanban fleet

echo "=== Agents generated in $TARGET ==="
ls .claude/agents/

echo "=== QA supervisor present? ==="
if [ -f .claude/agents/qa-supervisor.md ]; then
  echo "qa-supervisor.md OK"
  grep -c "Quinn" .claude/agents/qa-supervisor.md
else
  echo "WARNING: qa-supervisor.md not generated — check that $TARGET/.fleet/fleet.toml exists (Phase 3.5 seeds it)"
fi

echo "=== Launching kanban UI ==="
pgrep -f bead-kanban >/dev/null && echo "kanban already running" || {
  nohup bead-kanban > /tmp/bead-kanban.log 2>&1 &
  disown
  echo "Kanban UI started; logs: /tmp/bead-kanban.log"
}
echo "Kanban UI URL: http://localhost:3008"
```

---

## Done

Report:

```
INSTALL COMPLETE
  target project:      <TARGET>
  rtk:                 <version>
  beads-orchestration: installed
  bead-kanban:         installed (running on :3008)
  fleet:               installed
  fleet init:          <OK / skipped (no docker) / failed>
  orchestrator bootstrap: OK
  discovery supervisors:  <list from .claude/agents/>
  qa-supervisor:       <OK / missing>
```
