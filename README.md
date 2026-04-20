# ai-framework

Personal AI-agent framework that pairs an enforcement layer for Claude Code with a visual board and a multi-feature-branch runtime. Everything is wired around [beads](https://github.com/steveyegge/beads) — git-native tickets that live in the repo, so plans, context, and decisions survive past a single session.

## Structure

```
ai-framework/
├── The-Claude-Protocol/            # Orchestration + enforcement for Claude Code
├── kanban/                         # Next.js + Rust Kanban UI for beads
├── .claude/commands/install-stack.md  # One-shot installer (see below)
├── AGENTS.md                       # Agent instructions (shared)
└── CLAUDE.md                       # Project instructions for AI agents

$HOME/.cache/ai-framework/fleet/    # Fleet repo clone (user-level cache, managed by /install-stack)
```

### `The-Claude-Protocol/` (`beads-orchestration`)
Enforcement-first orchestration for Claude Code: 13 hooks, per-task git worktrees, auto-logged dispatch prompts, and a supervisor-per-stack pattern. See [its README](The-Claude-Protocol/README.md).

### `kanban/` (`bead-kanban`)
Visual Kanban UI for the beads CLI — multi-project dashboard, epic progress, PR status, memory and agents panels. See [its README](kanban/README.md).

### `fleet` (user-level cache clone at `$HOME/.cache/ai-framework/fleet`)
Runs multiple feature-branch versions of an app simultaneously on localhost. A gateway on `:3000` proxies to the active container, `:4000` hosts the admin dashboard. `/install-stack` clones the repo to `$HOME/.cache/ai-framework/fleet` and installs the `fleet` CLI globally; the CLI then contributes `infra-supervisor`, `react-supervisor`, `node-backend-supervisor`, the `fleet-manager` skill, and a `qa-supervisor` (Quinn) to the target project's `.claude/`. The per-project trigger is `.fleet/fleet.toml` (seeded by `/install-stack` Phase 3.5).

## How the pieces fit

1. **Plan** — The Claude Protocol orchestrator investigates and plans with you.
2. **Track** — Each unit of work becomes a bead (`bd create ...`).
3. **Visualize** — The kanban UI renders beads as cards across Open → In Progress → In Review → Closed.
4. **Execute** — Supervisors claim a bead, work in an isolated worktree, and open a PR. Fleet spins up a feature container per branch for QA.
5. **Merge** — PR merges close the bead automatically.

## Prerequisites

- [beads CLI](https://github.com/steveyegge/beads): `brew install steveyegge/beads/bd`
- `rtk` (Rust Token Killer): `brew install rtk`
- Node.js 18+ and Python 3
- Docker + Docker Compose v2 (for fleet)
- Claude Code
- Nothing else — `/install-stack` clones `fleet` and `mars-framework` into `$HOME/.cache/ai-framework/` on every run

## Quick start — `/install-stack`

From inside any target project, run the Claude Code slash command provided by this repo:

```
/install-stack
```

It performs, non-interactively:

1. Clones `mars-framework` + `fleet` into `$HOME/.cache/ai-framework/` and installs `rtk`, `beads-orchestration`, `bead-kanban`, and `fleet` CLIs globally from those cache clones.
2. Bootstraps The Claude Protocol into the target directory (agents, hooks, `.beads/`, kanban support).
3. Runs `fleet install-claude --local` so fleet's supervisors and `/fleet:*` commands overwrite the orchestrator stubs.
4. Seeds `.fleet/fleet.toml` in the target project (and runs `fleet init` if Docker is available).
5. Dispatches the `discovery` agent to generate tech-stack supervisors — plus a QA supervisor (Quinn) whenever the target project has a `.fleet/fleet.toml`.
6. Verifies CLIs on `PATH` and launches the kanban UI on `http://localhost:3008`.

Clone URLs are hard-coded in `.claude/commands/install-stack.md` — edit them if you fork `mars-framework` or `fleet`.

## Manual install

```bash
# The Claude Protocol into a target repo
cd The-Claude-Protocol && ./bootstrap.py --project-dir <target> --with-kanban-ui

# Kanban UI
cd kanban && npm install && npm run dev

# Fleet assets into a target repo
cd <target> && fleet install-claude --local
```

## Working on this repo

Task tracking uses `bd`, not markdown TODO lists. See `AGENTS.md` and `CLAUDE.md` for the full agent workflow and session-completion protocol.

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim
bd close <id>
```
