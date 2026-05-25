# ai-framework

Personal AI-agent framework that pairs an enforcement layer for Claude Code with a visual board and a multi-feature-branch runtime. Everything is wired around [beads](https://github.com/steveyegge/beads) — git-native tickets that live in the repo, so plans, context, and decisions survive past a single session.

## Structure

```
ai-framework/
├── The-Claude-Protocol/            # Orchestration + enforcement for Claude Code
├── kanban/                         # Next.js + Rust Kanban UI for beads
├── AGENTS.md                       # Agent instructions (shared)
└── CLAUDE.md                       # Project instructions for AI agents
```

### `The-Claude-Protocol/` (`beads-orchestration`)
Enforcement-first orchestration for Claude Code: 13 hooks, per-task git worktrees, auto-logged dispatch prompts, and a supervisor-per-stack pattern. See [its README](The-Claude-Protocol/README.md).

### `kanban/` (`bead-kanban`)
Visual Kanban UI for the beads CLI — multi-project dashboard, epic progress, PR status, memory and agents panels. See [its README](kanban/README.md).

### [`fleet`](https://github.com/ilies-bel/fleet) (published as [`@ilies-bel/fleet`](https://www.npmjs.com/package/@ilies-bel/fleet))
Runs multiple feature-branch versions of an app simultaneously on localhost. A gateway on `:3000` proxies to the active container, `:4000` hosts the admin dashboard. Install the CLI globally with `npm install -g @ilies-bel/fleet`, then run `fleet init` in the target project. The per-project config lives in `.fleet/fleet.toml`.

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

## Install

Install the CLIs, then bootstrap The Claude Protocol into your target project.

```bash
# 1. Global CLIs
brew install rtk
npm install -g @ilies-bel/fleet                 # fleet — multi-branch QA runtime
cd The-Claude-Protocol && npm install -g .      # beads-orchestration
cd ../kanban && npm install -g .                # bead-kanban (Kanban UI)

# 2. Bootstrap The Claude Protocol into a target repo
cd The-Claude-Protocol
./bootstrap.py --project-dir <target> --with-kanban-ui

# 3. Set up fleet in the target repo
cd <target>
fleet init                                      # interactive; needs Docker running

# 4. Launch the Kanban UI
bead-kanban                                      # serves http://localhost:3008
```

After bootstrap, the `discovery` agent generates tech-stack supervisors for the
target project — including a QA supervisor (Quinn) whenever the project has a
`.fleet/fleet.toml`.

## Working on this repo

Task tracking uses `bd`, not markdown TODO lists. See `AGENTS.md` and `CLAUDE.md` for the full agent workflow and session-completion protocol.

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim
bd close <id>
```
