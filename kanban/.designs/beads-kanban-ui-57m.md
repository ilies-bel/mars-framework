# Feature: PR File Changes Summary

## Overview

Show a list of changed files with additions/deletions inside the PR card in the bead-detail panel. Uses GitHub API to fetch PR file data.

## API Contract

### Backend Endpoint

```
GET /api/git/pr-files?repo_path=...&bead_id=...
```

Response:
```json
{
  "files": [
    {
      "filename": "src/app/project/kanban-board.tsx",
      "status": "modified",
      "additions": 16,
      "deletions": 4,
      "changes": 20
    }
  ],
  "total_additions": 84,
  "total_deletions": 6,
  "total_files": 5
}
```

File status values from GitHub API: `added`, `removed`, `modified`, `renamed`, `copied`, `changed`, `unchanged`.

### Rust Implementation

Add to `server/src/routes/worktree.rs` (where all PR endpoints live):

```rust
#[derive(Deserialize)]
pub struct PrFilesParams {
    pub repo_path: String,
    pub bead_id: String,
}

#[derive(Serialize)]
pub struct PrFileEntry {
    pub filename: String,
    pub status: String,
    pub additions: i32,
    pub deletions: i32,
    pub changes: i32,
}

#[derive(Serialize)]
pub struct PrFilesResponse {
    pub files: Vec<PrFileEntry>,
    pub total_additions: i32,
    pub total_deletions: i32,
    pub total_files: i32,
}
```

Implementation: Use `gh api repos/{owner}/{repo}/pulls/{number}/files` (same pattern as `get_pr_info`). Needs to find the PR number first via `gh pr view bd-{bead_id} --json number`.

Register route in `main.rs`:
```rust
.route("/api/git/pr-files", get(routes::worktree::pr_files))
```

### Frontend Types

Add to `src/types/index.ts`:
```typescript
export interface PRFileEntry {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PRFilesResponse {
  files: PRFileEntry[];
  total_additions: number;
  total_deletions: number;
  total_files: number;
}
```

### Frontend API

Add to `src/lib/api.ts` git object:
```typescript
prFiles: (repoPath: string, beadId: string) => fetchApi<PRFilesResponse>(
  `/api/git/pr-files?repo_path=${encodeURIComponent(repoPath)}&bead_id=${encodeURIComponent(beadId)}`
),
```

## UI Design

Render inside the existing PR card in `bead-detail.tsx`, between CI checks and action buttons.

```
┌─────────────────────────────────────────┐
│  PR #58                        ✓ 3/3   │
│  Checks: ✓ 3 passed                    │
│                                         │
│  Files Changed (5)              +84 -6  │
│  ┌─────────────────────────────────────┐│
│  │ M  kanban-board.tsx          +16 -4 ││
│  │ M  bead-card.tsx             +25 -1 ││
│  │ M  quick-filter-bar.tsx      +43 -1 ││
│  │ A  status-map.ts             +32    ││
│  │ D  old-file.ts                  -18 ││
│  └─────────────────────────────────────┘│
│                                         │
│  [View PR]  [Merge PR]                  │
└─────────────────────────────────────────┘
```

### Component: PRFilesList

New file: `src/components/pr-files-list.tsx`

- Status letter + color: M=zinc, A=green, D=red, R=amber
- Show basename only, full path in tooltip
- Green `+N` / red `-N` right-aligned
- Header row with total files count + total additions/deletions
- Use existing `ScrollArea` component (already installed), max-height ~200px
- Fetch data when PR exists and is not merged (no need to show files for merged PRs — they can view on GitHub)

### Data Flow

1. `bead-detail.tsx` detects PR exists and is open
2. Calls `api.git.prFiles(projectPath, beadId)`
3. Renders `<PRFilesList files={data.files} totals={...} />`
4. Uses `ScrollArea` for overflow, `Tooltip` for full paths
