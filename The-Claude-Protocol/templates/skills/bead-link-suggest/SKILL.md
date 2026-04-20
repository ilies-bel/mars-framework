---
name: bead-link-suggest
description: >
  Semantic bead-link suggester. Invoked by the suggest-bead-links hook when no
  explicit bead reference was found in a new bead's description. Scores open and
  in_progress beads for relevance to the new bead, proposes blocking deps for
  review, and optionally surfaces missing prerequisites.
---

# Bead Link Suggest

Triggered by `.claude/hooks/suggest-bead-links.sh` when a new bead was created
with no explicit `<prefix>-XXX` reference in its description.

`<prefix>` is whatever comes before the first `-` in this project's bead IDs
(e.g. `gustave` in `gustave-09n.4`, `bd` in `bd-42`). The hook supplies the
full new bead ID in the system-reminder; you never need to infer the prefix
manually.

## Required input

The system-reminder from the hook provides: `new bead ID: <prefix>-XXX`

Parse the ID from that reminder before starting.

## Workflow

### Step 1 — Gather data

```bash
bd show <new-id>
bd list --status=open
bd list --status=in_progress
```

Read and retain: new bead title, description, parent epic (if any), and the
full title list of all open/in_progress candidates.

### Step 2 — Score candidates

For each candidate bead (excluding the new bead itself), compute a relevance
score using these signals. Higher score = stronger link candidate.

| Signal | Points |
|--------|--------|
| Same domain keyword in title (frontend/backend/design/infra/db/schema/api/auth/mcp/jira/graph) | +3 |
| Keyword overlap between new title/description and candidate title | +1 per shared word (min 4 chars, ignore stop-words) |
| Same parent epic | +5 |
| Candidate title contains a noun from the new bead description | +2 |

**Thresholds:**
- Score >= 6 → high-confidence
- Score 3–5 → medium-confidence
- Score < 3 → ignore (do not surface)

### Step 3 — Apply or propose

**High-confidence candidates (score >= 6):**
Run immediately, no user confirmation needed:
```bash
bd dep add <new-id> <candidate-id>
bd comments add <new-id> "AUTO-LINKED: depends on <candidate-id> — semantic match (score <N>): <one-line rationale>"
```

**Medium-confidence candidates (score 3–5):**
List for the user with rationale. Wait for approval before running `bd dep add`.

Format:
```
Proposed dependency links for <new-id> — <new title>:

  [1] <candidate-id> — <candidate title>  (score: N)
      Rationale: <one sentence>

  [2] ...

Apply any? Enter numbers (e.g. 1 2), "all", or "none":
```

Apply only the approved ones, then log a comment for each.

**No candidates above threshold:**
Exit silently. Do not output anything.

### Step 4 — Missing prerequisite detection

After scoring, check whether the new bead's description references concepts
(e.g. "session schema", "admin panel", "rate limiting") for which no
open/in_progress bead exists that would plausibly deliver them.

If a gap is found, draft a `bd create` command and present it to the user:

```
Possible missing prerequisite detected for <new-id>:

  Concept: "<term from description>"
  No open bead found that would deliver this.

  Suggested bead:
    bd create "<suggested title>" -d "<suggested description>"

Create it? (yes / no / edit)
```

Only surface gaps that are clearly implied — do not invent spurious
prerequisites. When in doubt, omit.

## Constraints

- Link type: blocking deps only (`bd dep add` without `--type` flag, which defaults to `blocks`)
- Do NOT create soft `bd dep relate` links
- Do NOT suggest epic splits or supersede links
- Fail silently on `bd` errors (`|| true`)
- If no medium-confidence candidates and no missing prerequisites found after scoring, exit without output
