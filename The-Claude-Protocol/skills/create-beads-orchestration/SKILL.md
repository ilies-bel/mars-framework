---
name: create-beads-orchestration
description: Bootstrap lean multi-agent orchestration with beads task tracking. Use for projects needing agent delegation without heavy MCP overhead.
user-invocable: true
---

# Create Beads Orchestration

Set up lightweight multi-agent orchestration with git-native task tracking for Claude Code.

This skill is **non-interactive**: it auto-infers every decision (project name, directory, Kanban UI) and never asks the user a question. Override defaults with CLI flags if you need to.

## What This Skill Does

- **Orchestrator** (you) investigates issues, manages tasks, delegates implementation
- **Supervisors** (specialized agents) execute fixes in isolated worktrees
- **Beads CLI** tracks all work with git-native task management
- **Hooks** enforce workflow discipline automatically

Each task gets its own worktree at `.worktrees/bd-{BEAD_ID}/`.

---

## Step 0: Detect Setup State

Check for bootstrap artifacts:
```bash
ls .claude/agents/scout.md 2>/dev/null && echo "BOOTSTRAP_COMPLETE" || echo "FRESH_SETUP"
```

- `BOOTSTRAP_COMPLETE` → jump to **Step 3: Run Discovery**
- `FRESH_SETUP` → run **Step 1** then **Step 2**, then print the follow-up command for Step 3

---

## Step 1: Resolve Defaults (No User Prompts)

Resolve every input from the environment. Do **not** call `AskUserQuestion`.

1. **Project directory**: current working directory.
2. **Project name**: `package.json.name` → `pyproject.toml [project].name` → `Cargo.toml [package].name` → `go.mod` module last segment → directory basename. Bootstrap does this itself; you don't need to pass `--project-name`.
3. **Kanban UI**: probe `command -v bead-kanban`. If present, pass `--with-kanban-ui`. If absent, skip it. Never install it as a side effect of running this skill — the user can opt in by installing `beads-kanban-ui` separately and re-running.

```bash
if command -v bead-kanban >/dev/null 2>&1; then
  KANBAN_FLAG="--with-kanban-ui"
else
  KANBAN_FLAG=""
fi
```

---

## Step 2: Run Bootstrap

```bash
npx -y beads-orchestration@latest bootstrap --project-dir "$PWD" $KANBAN_FLAG
```

Bootstrap is idempotent and non-interactive. It will:
1. Install beads CLI (via brew, npm, or go)
2. Initialize `.beads/`
3. Copy agent templates to `.claude/agents/`
4. Copy hooks to `.claude/hooks/`
5. Configure `.claude/settings.json`
6. Create `CLAUDE.md`
7. Update `.gitignore`

On success, print this single line to the user and exit:

> Bootstrap complete. Hooks and agents load on the next Claude Code session. Restart, then run `/create-beads-orchestration` again (or ask me to "run discovery") to finish setup.

**Do not** run Step 3 in the same session as Step 2 — Claude Code only loads agents in `.claude/agents/` at session start, so the discovery agent isn't dispatchable yet. This is a platform constraint, not a user prompt.

---

## Step 3: Run Discovery (Second Session or When Step 0 Detected `BOOTSTRAP_COMPLETE`)

```python
Task(
    subagent_type="discovery",
    prompt="Detect tech stack and create supervisors for this project"
)
```

Discovery will:
- Scan `package.json`, `requirements.txt`, `Dockerfile`, etc.
- Fetch specialist agents from the external directory
- Inject beads workflow into each supervisor
- Write supervisors to `.claude/agents/`

After discovery completes, print:

> Orchestration setup complete. Supervisors: [list]. Create tasks with `bd create "Task name" -d "Description"`.

---

## What This Creates

- **Beads CLI** for git-native task tracking (one bead = one worktree = one task)
- **Core agents**: scout, detective, architect, scribe, code-reviewer
- **Discovery agent**: auto-creates supervisors for your tech stack
- **Hooks**: enforce orchestrator discipline, code review gates, concise responses
- **Worktree-per-task workflow**: `.worktrees/bd-{BEAD_ID}/`

With `--with-kanban-ui`: worktrees created via API (localhost:3008) with git fallback. Without: raw git worktrees.

## Epic Workflow (Cross-Domain Features)

For features spanning multiple supervisors (DB + API + Frontend):

1. `bd create "Feature name" -d "Description" --type epic`
2. Dispatch architect to create `.designs/{EPIC_ID}.md` if needed
3. `bd update {EPIC_ID} --design ".designs/{EPIC_ID}.md"`
4. Create children with dependencies:
   ```bash
   bd create "DB schema" -d "..." --parent {EPIC_ID}
   bd create "API" -d "..." --parent {EPIC_ID} --deps BD-001.1
   bd create "Frontend" -d "..." --parent {EPIC_ID} --deps BD-001.2
   ```
5. Dispatch with `bd ready` (each child gets its own worktree)
6. Wait for each child's PR to merge before dispatching the next
7. `bd close {EPIC_ID}` after all children merge

Hooks `enforce-sequential-dispatch.sh`, `enforce-bead-for-supervisor.sh`, and `validate-completion.sh` enforce the epic rules.

## Requirements

- **beads CLI**: installed automatically by bootstrap

## More Information

See the full documentation: https://github.com/AvivK5498/The-Claude-Protocol
