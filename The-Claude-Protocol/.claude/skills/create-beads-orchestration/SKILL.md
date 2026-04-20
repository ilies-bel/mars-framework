---
name: create-beads-orchestration
description: Bootstrap lean multi-agent orchestration with beads task tracking. Use for projects needing agent delegation without heavy MCP overhead.
user-invocable: true
---

# Create Beads Orchestration

Set up lightweight multi-agent orchestration with git-native task tracking and mandatory code review gates.

This skill is **non-interactive**. It auto-infers every decision and never calls `AskUserQuestion`. Defaults: `--claude-only` for provider mode, current working directory for project dir, inferred project name, and auto-detected Kanban UI.

---

## Step 0: Detect Setup State

```bash
ls .claude/agents/scout.md 2>/dev/null && echo "BOOTSTRAP_COMPLETE" || echo "FRESH_SETUP"
```

- `BOOTSTRAP_COMPLETE` → jump to **Step 3: Run Discovery**
- `FRESH_SETUP` → proceed to Step 1

---

## Step 1: Resolve Defaults (No User Prompts)

Do **not** ask the user anything. Resolve from the environment:

1. **Project directory**: `pwd`.
2. **Project name**: bootstrap infers from `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or directory name. Don't pass `--project-name` unless overriding.
3. **Provider mode**: default to `--claude-only` (Claude Task for every agent, no external providers). Only omit the flag if the caller explicitly asked for Codex/Gemini delegation in their prompt.
4. **Kanban UI**: `command -v bead-kanban` — pass `--with-kanban-ui` if present, skip otherwise. Never auto-install it.

```bash
KANBAN_FLAG=""
if command -v bead-kanban >/dev/null 2>&1; then
  KANBAN_FLAG="--with-kanban-ui"
fi
```

---

## Step 2: Run Bootstrap

```bash
git clone --depth=1 https://github.com/AvivK5498/The-Claude-Protocol "${TMPDIR:-/tmp}/beads-orchestration-setup"

python3 "${TMPDIR:-/tmp}/beads-orchestration-setup/bootstrap.py" \
  --project-dir "$PWD" \
  --claude-only \
  $KANBAN_FLAG
```

Drop `--claude-only` only if the user explicitly requested external providers.

Bootstrap will:
1. Install beads CLI (brew / npm / go)
2. Initialize `.beads/`
3. Copy agents to `.claude/agents/`
4. Copy hooks to `.claude/hooks/`
5. Write `.claude/settings.json`
6. Set up `.mcp.json` for `provider_delegator` (external providers mode only)
7. Create `CLAUDE.md`
8. Update `.gitignore`

On success, print:

> Bootstrap complete. Hooks and agents activate on the next Claude Code session. Restart, then run `/create-beads-orchestration` (or ask me to "run discovery") to finish setup.

Do not run Step 3 in the same session — Claude Code only loads `.claude/agents/` at session start, so the discovery agent isn't callable yet. This is a platform constraint, not a user prompt.

---

## Step 3: Run Discovery (Second Session or Step 0 Detected `BOOTSTRAP_COMPLETE`)

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

## Cleanup (Optional)

```bash
rm -rf "${TMPDIR:-/tmp}/beads-orchestration-setup"
```

---

## What This Creates

- **Beads CLI** for git-native task tracking (one bead = one branch = one task)
- **Core agents**: scout, detective, architect, scribe, code-reviewer
- **Discovery agent**: auto-creates specialized supervisors
- **Hooks**: enforce orchestrator discipline, code review gates, concise responses
- **Branch-per-task workflow**: parallel development with automated merge conflict handling

**Claude-only mode (default):** all agents run via Claude Task(), no external dependencies.

**External providers mode:** MCP Provider Delegator enables Codex → Gemini → Claude fallback. Requires `codex login` and optional `gemini` CLI, plus `uv`.

## Requirements

**Claude-only (default):** `beads` CLI (auto-installed), nothing else.

**External providers:** Codex CLI, optional Gemini CLI, `uv`.

## More Information

https://github.com/AvivK5498/The-Claude-Protocol
