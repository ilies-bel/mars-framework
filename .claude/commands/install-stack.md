---
description: Non-interactive install of rtk, bead-orchestrator, kanban-ui, and fleet; bootstrap the orchestrator and generate supervisors including a QA supervisor tied to ../fleet/qa-fleet/
allowed-tools: Bash, Task, Read, Glob
---

Execute the following phases in order. Do NOT ask the user any questions. Run each Bash block in a single tool call; run the discovery dispatch in Phase 4 as a Task call (not bash).

---

## Phase 0 — environment

```bash
set -e
AIFW=/Users/ib472e5l/project/perso/ai-framework
FLEET=/Users/ib472e5l/project/perso/fleet/qa-fleet
cd "$AIFW"

command -v rtk >/dev/null 2>&1 || brew install rtk
command -v npm >/dev/null 2>&1 || { echo "npm required"; exit 1; }

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

## Phase 1 — install CLIs from local paths

```bash
set -e
AIFW=/Users/ib472e5l/project/perso/ai-framework
FLEET=/Users/ib472e5l/project/perso/fleet/qa-fleet

npm install -g "$AIFW/The-Claude-Protocol"
npm install -g "$AIFW/Beads-Kanban-UI"
npm install -g "$FLEET"

command -v beads-orchestration
command -v bead-kanban
command -v fleet
```

---

## Phase 2 — orchestrator run #1 (bootstrap)

`beads-orchestration setup` is non-interactive; it auto-detects `bead-kanban` on PATH and enables `--with-kanban-ui` accordingly (see `The-Claude-Protocol/scripts/cli.js` lines 55-62).

```bash
set -e
AIFW=/Users/ib472e5l/project/perso/ai-framework
beads-orchestration setup --project-dir "$AIFW"
```

This writes into `$AIFW`:
- `.claude/agents/` (scout, detective, architect, scribe, discovery, code-reviewer, merge-supervisor)
- `.claude/hooks/`, `.claude/settings.json`
- `.claude/beads-workflow-injection.md`, `ui-constraints.md`, `frontend-reviews-requirement.md`, `CLAUDE.md`
- `.beads/` (Dolt config, kanban.json, memory/)

It also copies the `create-beads-orchestration` skill to `~/.claude/skills/`.

---

## Phase 3 — wire fleet Claude assets

```bash
set -e
AIFW=/Users/ib472e5l/project/perso/ai-framework
cd "$AIFW"
npx --yes @ilies-bel/fleet install-claude --local
```

Merges fleet's `infra-supervisor.md`, `react-supervisor.md`, `node-backend-supervisor.md`, the `fleet-manager` skill, and `/fleet:init` + `/fleet:add` commands into `$AIFW/.claude/`. Run AFTER Phase 2 so fleet's versions (which know about the Docker gateway) overwrite the orchestrator's stubs.

---

## Phase 4 — orchestrator run #2 (supervisor generation)

Dispatch the `discovery` subagent as a Task call (NOT bash). Use this exact prompt:

> BEAD_ID: bootstrap-discovery
>
> Run full discovery in `/Users/ib472e5l/project/perso/ai-framework`. The sibling path `../fleet/qa-fleet/` EXISTS — you MUST emit `.claude/agents/qa-supervisor.md` per Step 3.6 of your instructions (Quinn, QA supervisor, references fleet-manager skill). Do NOT ask questions. Write all supervisors and then report.

The patched discovery agent (Step 3.6 added to its template) will detect `../fleet/qa-fleet/` and generate `qa-supervisor.md` alongside the tech-stack supervisors.

---

## Phase 5 — verify and launch kanban UI

```bash
set -e
AIFW=/Users/ib472e5l/project/perso/ai-framework
cd "$AIFW"

echo "=== CLIs on PATH ==="
which rtk beads-orchestration bead-kanban fleet

echo "=== Agents generated ==="
ls .claude/agents/

echo "=== QA supervisor present? ==="
if [ -f .claude/agents/qa-supervisor.md ]; then
  echo "qa-supervisor.md OK"
  grep -c "Quinn" .claude/agents/qa-supervisor.md
else
  echo "WARNING: qa-supervisor.md not generated — check that ../fleet/qa-fleet/ is reachable from $AIFW"
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
  rtk:                 <version>
  beads-orchestration: installed
  bead-kanban:         installed (running on :3008)
  fleet:               installed
  orchestrator bootstrap: OK
  discovery supervisors:  <list from .claude/agents/>
  qa-supervisor:       <OK / missing>
```
