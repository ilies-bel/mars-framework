---
name: dispatch-route
description: >
  Pre-dispatch classifier. Run BEFORE every Task() supervisor dispatch on a bead.
  Tags the bead with `lane:auto-merge` or `lane:fleet-gated`, which the
  Post-Task Merge Protocol later uses to decide between auto-FF-merge and
  fleet-container-gated review. Blocks dispatch when the bead is too vague to
  classify.
---

# Dispatch Route

Decides which **merge lane** a bead belongs to **before** the supervisor is
dispatched, and tags the bead with a label so the Post-Task Merge Protocol can
act deterministically when the supervisor returns.

## When to invoke

The orchestrator MUST run this skill immediately before any
`Task(subagent_type="*-supervisor", ...)` call, including the first dispatch
of an epic child. Skip only for `merge-supervisor` (which is exempt from the
bead requirement entirely).

If the bead already has a `lane:*` label, **the skill is a no-op** — respect
the existing label as a manual override.

## Required input

- `BEAD_ID` — the bead about to be dispatched
- `SUBAGENT_TYPE` — the supervisor that will receive the dispatch
- The dispatch prompt (used as a description fallback for classification)

## Lanes

| Label | Meaning | Post-task behavior |
|-------|---------|---------------------|
| `lane:auto-merge` | Non-user-facing change | Rebase → tests green → **auto FF-merge** to main → close bead. No user prompt. |
| `lane:fleet-gated` | User-facing feature | Rebase → **auto-spin** `fleet add bd-{ID} bd-{ID}` → surface container URL → wait for user `merge`/`reject` verdict → FF-merge → `fleet rm bd-{ID}`. |

## Workflow

### Step 1 — Pre-flight: vague-bead guard

Run:

```bash
bd show {BEAD_ID}
```

Check:

- Description length ≥ 80 chars, OR
- Description contains at least one of: a file path (`/`, `.kt`, `.tsx`, `.ts`, `.py`, `.go`, `.rs`, `.sql`), a function/class name (`CamelCase` or `snake_case`), or a clearly scoped verb-noun (`add`, `fix`, `refactor`, `migrate`, `rename` + a target).

**If neither is true**, abort dispatch and surface to the user:

```
Bead {BEAD_ID} is too vague to classify into a merge lane.
Add a description with file paths or a clear scope, then re-dispatch.
Run: bd update {BEAD_ID} --description "..."
```

Do NOT default-classify a vague bead. Do NOT dispatch.

### Step 2 — Existing-label check

```bash
bd label list {BEAD_ID}
```

If output contains `lane:auto-merge` or `lane:fleet-gated` → **stop, no-op**,
proceed to dispatch.

### Step 3 — Classifier cascade (first match wins)

Apply rules in order. As soon as one matches, stop and apply the label.

#### Rule 1 — Supervisor type (by tech-prefix convention)

| Supervisor prefix | Lane |
|-------------------|------|
| `react-`, `nextjs-`, `vue-`, `svelte-`, `angular-` (frontend) | `lane:fleet-gated` |
| `infra-`, `devops-`, `ci-`, `terraform-`, `docker-` | `lane:auto-merge` |
| `qa-`, `test-` | `lane:auto-merge` |
| `node-backend-`, `kotlin-backend-`, `python-backend-`, `rust-`, `go-`, `java-` | continue to Rule 2 |

Unknown prefixes fall through to Rule 2 as well.

#### Rule 2 — Paths in bead description

Read the bead description and the dispatch prompt for path mentions.

| Path signal | Lane |
|-------------|------|
| `frontend/**`, `web/**`, `client/**`, `ui/**`, `app/**` (Next.js app router) | `lane:fleet-gated` |
| New HTTP route: `@RestController`, `@PostMapping`, `@GetMapping`, `@RequestMapping`, `app.get/post/put`, `router.get/post/put`, new controller or handler file | `lane:fleet-gated` |
| API gateway route handler additions/changes | `lane:fleet-gated` |
| Migration only (`db/changelog/**`, `migrations/**`, `*__*.sql`) with no controller/DTO changes | `lane:auto-merge` |
| `*Service.kt`, `*Repository.kt`, `*Mapper.kt`, `*_service.py`, internal helpers only (no controller) | `lane:auto-merge` |
| `**/test/**`, `**/*Test.kt`, `**/*.test.ts`, `**/*.spec.ts`, `**/*_test.go`, `**/test_*.py` | `lane:auto-merge` |
| `*.md`, `docs/**`, `CLAUDE.md`, `.beads/**` | `lane:auto-merge` |
| `.github/**`, `Dockerfile`, `docker-compose*.yml`, `Caddyfile`, `helm/**`, `.circleci/**`, `.gitlab-ci.yml` | `lane:auto-merge` |

#### Rule 3 — Keywords in title/description

Match case-insensitively against title + description + dispatch prompt.

| Keyword family | Lane |
|----------------|------|
| `UI`, `screen`, `dashboard`, `view`, `page`, `component`, `flow`, `endpoint`, `API`, `feature`, `button`, `modal`, `form`, `chart`, `graph view` | `lane:fleet-gated` |
| `refactor`, `rename`, `extract`, `inline`, `cleanup`, `dead code`, `unused`, `migrate`, `migration`, `bump`, `upgrade dep`, `internal`, `helper`, `util`, `test`, `spec`, `coverage`, `docs`, `comment`, `typo`, `lint`, `format`, `CI`, `pipeline` | `lane:auto-merge` |

#### Rule 4 — Ambiguous → ASK

If no rule matched, the orchestrator MUST pause and call `AskUserQuestion`:

```
Question: "Bead {BEAD_ID} ({title}) — which merge lane?"
Options:
  - lane:auto-merge — non-user-facing, FF-merge after tests
  - lane:fleet-gated — user-facing, spin fleet container for review
Header: "Merge lane"
```

Tag with the user's choice.

### Step 4 — Apply the label

```bash
bd label add {BEAD_ID} lane:auto-merge
# or
bd label add {BEAD_ID} lane:fleet-gated
```

Then add a one-line audit comment so the rationale is traceable:

```bash
bd comment add {BEAD_ID} "DISPATCH_ROUTE: lane=<lane> rule=<rule-N> rationale=<short>"
```

### Step 5 — Proceed to dispatch

Continue with the original `Task(subagent_type=..., prompt="BEAD_ID: ...")`
call. The label travels with the bead and is read by the Post-Task Merge
Protocol when the supervisor returns COMPLETE.

## Post-Task Merge Protocol — lane-aware variant

When the supervisor returns `BEAD {ID} COMPLETE`:

```bash
LANE=$(bd label list {ID} | grep -oE 'lane:(auto-merge|fleet-gated)' | head -1)
```

### `lane:auto-merge`

```bash
# Orchestrator stays in main checkout. Uses git -C to target the worktree.
git -C .worktrees/bd-{ID} fetch origin main 2>/dev/null || true
git -C .worktrees/bd-{ID} rebase main    # on conflict → dispatch merge-supervisor, then resume
# pre-commit hook runs tests during rebase
git checkout main
git merge --ff-only bd-{ID}
bd update {ID} --status closed
bd close {ID}
```

**No user approval prompt.** Tests are the gate. If pre-commit fails, stop and
surface the failure to the user.

### `lane:fleet-gated`

```bash
# Orchestrator stays in main checkout. Uses git -C to target the worktree.
git -C .worktrees/bd-{ID} fetch origin main 2>/dev/null || true
git -C .worktrees/bd-{ID} rebase main    # on conflict → dispatch merge-supervisor, then resume
fleet add "bd-{ID}" "bd-{ID}"      # auto-spin, no prompt
# wait for RUNNING + /backend/actuator/health (per fleet:add skill)
```

Surface to user:

```
✓ bd-{ID} ready for review
  URL: <fleet-url>
  Reply 'merge' to FF-merge to main, 'reject' to abandon.
```

On `merge`:

```bash
git checkout main
git merge --ff-only bd-{ID}
bd update {ID} --status closed
bd close {ID}
fleet rm "bd-{ID}"
```

On `reject`: leave the worktree, leave the container running for diagnosis,
ask the user how to proceed (rework / discard / re-dispatch).

## Anti-patterns

- ❌ Dispatching without invoking this skill
- ❌ Defaulting a vague bead to `lane:auto-merge` instead of blocking
- ❌ Tagging both labels on the same bead
- ❌ Auto-merging a `lane:fleet-gated` bead without the user's `merge` reply
- ❌ Spinning a fleet container for `lane:auto-merge` (waste of resources)
- ❌ Re-classifying a bead that already has a `lane:*` label (respect overrides)
- ❌ Orchestrator resolving rebase conflicts itself (always dispatch merge-supervisor)
- ❌ Orchestrator `cd`-ing into `.worktrees/bd-{ID}` instead of using `git -C`
