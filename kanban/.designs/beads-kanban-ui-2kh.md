# Feature: Display relates_to Links in UI

**Epic:** beads-kanban-ui-2kh
**Created:** 2026-01-27

## Overview

Add support for displaying `relates_to` dependency links across the beads-kanban-ui. The `bd dep relate` CLI command creates bidirectional "see also" relationships between beads (stored as `type: "relates-to"` in the dependencies array). Currently the Rust backend ignores this type entirely and the frontend has no concept of related tasks.

## Requirements

- R1: Backend extracts `relates-to` dependencies and exposes them as a `relates_to` field on each bead
- R2: Task cards on the kanban board show a compact "related" indicator with count
- R3: Epic subtask rows show a compact "related" indicator per child
- R4: Bead detail panel shows a "Related Tasks" section with clickable links to related beads
- R5: Clicking a related task navigates to that bead's detail panel

## Constraints

- C1: Must follow existing Bead struct patterns in beads.rs (serde derive, Option fields)
- C2: Must not affect existing blocking/parent-child dependency processing
- C3: Must use existing shadcn/ui components and lucide-react icons (Link2 for relations)
- C4: The `relates_to` field should contain bead IDs only (matching `deps` pattern)

## Schema

### JSONL Format (Existing — Read Only)

The `dependencies` array in `.beads/issues.jsonl` stores relates-to links:

```json
{
  "id": "beads-kanban-ui-k0q",
  "dependencies": [
    {
      "issue_id": "beads-kanban-ui-k0q",
      "depends_on_id": "beads-kanban-ui-70z",
      "type": "relates-to",
      "created_at": "2026-01-27T18:21:35.938592+02:00",
      "created_by": "Aviv Kaplan"
    }
  ]
}
```

Links are **bidirectional** — both beads get a dependency entry pointing to each other.

### Existing Dependency Types

| Type | Meaning | Current Handling |
|------|---------|-----------------|
| `parent-child` | Epic → child task | Extracted into `parent_id` + `children` fields |
| `blocks` | Task A blocks Task B | Extracted into `deps` field (unresolved only) |
| `relates-to` | Bidirectional "see also" | **NEW: Extract into `relates_to` field** |

## API Changes

### GET /api/beads?path={project_path}

**Response change:** Each bead object gains a new optional field:

```json
{
  "id": "beads-kanban-ui-k0q",
  "title": "...",
  "relates_to": ["beads-kanban-ui-70z", "beads-kanban-ui-abc"]
}
```

`relates_to` is an array of bead IDs that have a `relates-to` link with this bead. Empty array or absent if no relations.

No new endpoints needed — the existing `/api/beads` endpoint is extended.

## Shared Types

### Rust (modify `server/src/routes/beads.rs`)

Add to the existing `Bead` struct:

```rust
#[serde(default)]
pub relates_to: Option<Vec<String>>,
```

### TypeScript (modify `src/types/index.ts`)

Add to the existing `Bead` interface:

```typescript
relates_to?: string[];  // Bead IDs with relates-to links
```

## Data Flow

### Backend Processing (beads.rs `read_beads`)

After the existing three-pass parent/child inference (lines 140-208), add a fourth pass:

1. Iterate all beads
2. For each bead, check its `dependencies` array for entries with `type == "relates-to"`
3. Collect the `depends_on_id` values into a new `relates_to` Vec
4. Set `bead.relates_to = Some(related_ids)` (or None if empty)

This is simpler than blocking deps — no filtering by status needed. Relations are permanent "see also" links regardless of bead state.

### Frontend Display

#### 1. Task Card (`bead-card.tsx`)

In the `CardFooter` section (after comment count), add a related tasks indicator:

```
[💬 3 comments] [🔗 2 related]
```

- Icon: `Link2` from lucide-react (size-3)
- Text: `{count} related`
- Style: Same muted foreground as comment count (`text-[10px] text-muted-foreground`)
- Only show when `relates_to.length > 0`

#### 2. Epic Subtask Row (`subtask-list.tsx` or wherever child tasks are rendered)

Add a small `Link2` icon + count next to each child's status badge:

```
✓ Fix login bug          🔗2
○ Add validation
● Update tests           🔗1
```

- Icon: `Link2` (size-3), muted foreground
- Count: inline, no "related" text (space-constrained)
- Only show when child has `relates_to.length > 0`

#### 3. Bead Detail Panel (`bead-detail.tsx`)

Add a "Related Tasks" section in the detail sheet, below the description and above the comments:

```
Related Tasks
┌────────────────────────────────┐
│ ○ BD-70z  Test bead B    open  │
│ ✓ BD-abc  Fix login    closed  │
└────────────────────────────────┘
```

- Section header: "Related Tasks" with `Link2` icon
- Each row: status icon + formatted bead ID + title + status badge
- Clickable: navigates to the related bead (reuses `onChildClick` / `handleSelectBead` pattern)
- Only show section when `relates_to.length > 0`
- Look up related bead data from `allBeads` prop (already available)

## New Files

None — all changes are modifications to existing files.

## Modified Files

### Backend (Rust)

| File | Change |
|------|--------|
| `server/src/routes/beads.rs` | Add `relates_to` field to Bead struct; add fourth pass in `read_beads` to extract relates-to deps |

### Frontend (Next.js)

| File | Change |
|------|--------|
| `src/types/index.ts` | Add `relates_to?: string[]` to Bead interface |
| `src/components/bead-card.tsx` | Add related count in CardFooter |
| `src/components/bead-detail.tsx` | Add "Related Tasks" section |
| `src/components/subtask-list.tsx` | Add related count badge per child (check actual file name) |

## Implementation Tasks

### Task 1: beads-kanban-ui-2kh.1 — Rust Backend: Extract relates-to Dependencies
**Supervisor:** rust-supervisor

- Add `relates_to: Option<Vec<String>>` to Bead struct
- Add fourth pass in `read_beads` to extract `type == "relates-to"` from dependencies
- Add test for relates-to extraction

### Task 2: beads-kanban-ui-2kh.2 — Next.js Frontend: Display Related Tasks
**Supervisor:** nextjs-supervisor
**Depends on:** beads-kanban-ui-2kh.1

- Add `relates_to` to TypeScript Bead type
- Add related count badge to bead-card.tsx footer
- Add related count to subtask rows
- Add "Related Tasks" section to bead-detail.tsx
- Wire up navigation from related task click

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| No test data with relates-to links | Create test beads with `bd dep relate` or use test fixtures |
| Related bead might not be in `allBeads` (e.g., cross-project) | Only show relations where the target bead exists in current data; skip unknown IDs gracefully |
| Bidirectional means both beads show the link | This is desired behavior — both sides should show the relation |
| Large number of relations clutters cards | Unlikely in practice; show count only on cards, full list only in detail panel |
