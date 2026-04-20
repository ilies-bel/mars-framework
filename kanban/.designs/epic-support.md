# Epic Support for Beads Kanban UI

## Codebase Analysis Summary

### Technology Stack
- **Frontend**: Next.js 14, React 18, TypeScript, Tailwind CSS, shadcn/ui (Radix UI primitives)
- **Backend**: Rust with Axum, SQLite for project metadata
- **Data Source**: `.beads/issues.jsonl` files (JSONL format)
- **Real-time**: Server-Sent Events (SSE) for file watching
- **Icons**: Lucide React

### Current Data Model (`/src/types/index.ts`)
```typescript
interface Bead {
  id: string;
  title: string;
  description?: string;
  status: BeadStatus; // 'open' | 'in_progress' | 'inreview' | 'closed'
  priority: number;
  issue_type: string;
  owner: string;
  created_at: string;
  updated_at: string;
  comments: Comment[];
}
```

**Missing fields for epic support**:
- `parent_id?: string` - For child tasks
- `children?: string[]` - For epic tasks
- `issue_type: 'task' | 'epic'` - Already exists but not leveraged
- `design_doc?: string` - Path to design doc (e.g., `.designs/{EPIC_ID}.md`)
- `deps?: string[]` - Dependencies for sequencing

**Important Notes**:
- Existing beads without `issue_type` should default to `'task'`
- `blockers` is a **computed field** derived from `deps` relationships (not stored in data)

### Current Component Structure
- `KanbanColumn` - Renders a single column with list of `BeadCard` components
- `BeadCard` - Individual task card with priority, status, branch info
- `BeadDetail` - Sheet panel showing full bead details
- `kanban-board.tsx` - Main board orchestrating columns and detail panel

### API Layer
- Beads read via `GET /api/beads?path=`
- CLI commands via `POST /api/bd/command` (whitelisted: list, show, comment, update, close, create)
- File watching via SSE at `/api/watch/beads`
- Design doc reading would need new endpoint: `GET /api/fs/read?path=`

---

## Implementation Plan

### Phase 1: Backend Extensions (Rust Struct + Endpoints + CLI)

**1.1 Extend Rust Bead struct** (`/server/src/routes/beads.rs`)
```rust
pub struct Bead {
    // ... existing fields
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub children: Option<Vec<String>>,
    #[serde(default)]
    pub design_doc: Option<String>,
    #[serde(default)]
    pub deps: Option<Vec<String>>,
    // NOTE: blockers is NOT stored - computed client-side from deps relationships
}
```

**1.2 Update CLI whitelist** (`/server/src/routes/bd.rs`)
```rust
const ALLOWED_COMMANDS: &[&str] = &[
    "list", "show", "comment", "update", "close", "create",
    "ready", "epic"  // NEW: for bd ready and bd epic status
];
```

**1.3 Add design doc read endpoint** (`/server/src/routes/fs.rs`)
```rust
// GET /api/fs/read?path=.designs/{EPIC_ID}.md
pub async fn read_file(Query(params): Query<FsReadParams>) -> impl IntoResponse

// Security constraints:
// - Max file size: 100KB
// - Only .md extension allowed
// - Path must be within project directory
// - Path must start with ".designs/"
```

---

### Phase 2: Frontend Types & Data Layer

**2.1 Extend TypeScript Types** (`/src/types/index.ts`)
```typescript
// Extended Bead interface
interface Bead {
  // ... existing fields
  parent_id?: string;         // ID of parent epic (for children)
  children?: string[];        // IDs of child tasks (for epics)
  design_doc?: string;        // Path like ".designs/{EPIC_ID}.md"
  deps?: string[];            // Dependency IDs (blocking this task)
  blockers?: string[];        // COMPUTED: Tasks this blocks (derived from deps relationships)
}

// New Epic-specific types
interface Epic extends Bead {
  issue_type: 'epic';
  children: string[];
  progress?: EpicProgress;
}

interface EpicProgress {
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
}
```

**Note on blockers field**: The `blockers` field is **computed client-side** from analyzing the `deps` relationships of all beads. It should NOT be stored in the data model. When processing beads, compute blockers dynamically based on which beads list the current bead in their `deps` array.

**2.2 Create epic-parser utility** (`/src/lib/epic-parser.ts`)
- `parseEpicsAndTasks(beads)` - Separate epics from standalone tasks
- `buildEpicTree(epics, tasks)` - Attach children to parent epics
- `computeEpicProgress(epic)` - Calculate completion percentages
- `getBlockedTasks(tasks)` - Identify tasks with unresolved deps
- `computeBlockers(bead, allBeads)` - Compute which beads this task blocks

**2.3 Extend beads-parser** (`/src/lib/beads-parser.ts`)
- Add `groupByEpicStatus()` for epic-specific grouping
- Add `getEpicChildren(epicId, beads)` helper
- Add `isEpicCompleted(epic)` check

---

### Phase 3: UI Components (EpicCard, SubtaskList, DesignDocViewer, DependencyBadge)

**3.1 EpicCard Component** (`/src/components/epic-card.tsx`)
- Larger card with distinctive styling (gradient border, icon)
- Progress bar showing children completion (3/5)
- Collapsed children preview (first 2-3 titles)
- Expand/collapse toggle
- Design doc indicator badge
- Different visual treatment from regular BeadCard

**3.2 SubtaskList Component** (`/src/components/subtask-list.tsx`)
- Compact list of child tasks within epic card
- Checkbox-style status indicators
- Click to open child detail
- Drag-to-reorder (future enhancement)

**3.3 DesignDocViewer Component** (`/src/components/design-doc-viewer.tsx`)
- Markdown renderer for `.designs/{EPIC_ID}.md`
- Collapsible sections
- Code syntax highlighting
- Full-screen toggle
- **Dependencies**: Requires `react-markdown` and `rehype-highlight` (or similar syntax highlighting library) packages

**3.4 EpicDetailPanel Component** (`/src/components/epic-detail.tsx`)
- Extended BeadDetail with:
  - Design doc tab/section
  - Children list with status
  - Dependency graph visualization
  - Progress metrics
  - Epic-level timeline

**3.5 DependencyBadge Component** (`/src/components/dependency-badge.tsx`)
- Shows blocked/blocking status
- Tooltip with dependency names
- Click to navigate to blocker

---

### Phase 4: Board Integration (KanbanColumn filtering, useEpics hook, kanban-board updates)

**4.1 Update kanban-board.tsx** (`/src/app/project/kanban-board.tsx`)
- Filter child tasks before rendering columns:
```typescript
// In kanban-board.tsx before passing to KanbanColumn
const topLevelBeads = beads.filter(b => !b.parent_id);
```
- Render `EpicCard` for `issue_type: 'epic'`
- Keep `BeadCard` for standalone tasks
- Hide child tasks from top-level (they show inside epics)
- Add filter: "Show: All | Epics Only | Tasks Only"
- Add grouping: "Group by: Status | Epic"
- Handle epic expansion state
- Route to EpicDetailPanel or BeadDetail based on type

**4.2 Update KanbanColumn** (`/src/components/kanban-column.tsx`)
- Render `EpicCard` for `issue_type: 'epic'`
- Keep `BeadCard` for non-epic tasks
- Only receives top-level beads (already filtered)

**4.3 New useEpics hook** (`/src/hooks/use-epics.ts`)
- Derived from useBeads
- Separates epics and tasks
- Computes progress for each epic
- Handles expansion state
- Filters to only top-level beads

---

### Phase 5: Enhanced Features (Optional)

**5.1 Epic Progress Indicator**
- Circular progress ring or horizontal bar
- Color-coded: green (done), amber (in progress), gray (pending), red (blocked)
- Fraction display: "3/5 children"

**5.2 Dependency Visualization**
- Mini dependency graph in epic detail
- Lines connecting dependent children
- Blocked tasks highlighted in red
- Topological ordering display

**5.3 Design Doc Editing** (Future)
- Inline Markdown editor
- Auto-save on blur
- Version history via git

**5.4 Epic Timeline/Burndown View**
- Gantt-style timeline for children
- Burndown chart showing completion over time
- Estimated vs actual completion

**5.5 Enhanced Filtering**
- Filter by epic vs standalone
- Filter by dependency status (blocked/unblocked)
- Filter by epic parent
- "Ready to work" view (bd ready equivalent)

**5.6 UX Improvements**
- Keyboard shortcut: `E` to toggle epic filter
- Drag children between epics
- Bulk operations on epic children
- Epic templates for common patterns

---

## Implementation Sequence

| Phase | Description | Dependencies |
|-------|-------------|--------------|
| 1 | Backend Extensions (Rust struct, GET /api/fs/read, CLI whitelist) | None |
| 2 | Frontend Types & Data Layer (TypeScript types, epic-parser, beads-parser) | Phase 1 |
| 3 | UI Components (EpicCard, SubtaskList, DesignDocViewer, DependencyBadge) | Phase 2 |
| 4 | Board Integration (KanbanColumn filtering, useEpics hook, kanban-board updates) | Phase 3 |
| 5 | Enhanced Features (progress indicators, dependency visualization, filtering) | Phase 4 |

---

## Critical Files for Implementation

| File | Purpose |
|------|---------|
| `/src/types/index.ts` | Core type extensions for epic/parent/children |
| `/src/components/bead-card.tsx` | Pattern to follow for EpicCard |
| `/src/app/project/kanban-board.tsx` | Main integration point |
| `/server/src/routes/beads.rs` | Backend bead struct to extend |
| `/src/lib/beads-parser.ts` | Data processing utilities to extend |

---

## Required Deliverables

1. **Kanban board clearly separates epics/tasks** - EpicCard vs BeadCard rendering
2. **Epic item has design document viewer** - DesignDocViewer component
3. **Epic items contain all sub tasks** - SubtaskList within EpicCard
4. **User can open sub tasks through epic** - Click handler to BeadDetail

## Bonus Features

- Progress indicators (3/5 children done)
- Dependency visualization
- "Ready to work" filter
- Epic timeline view
- Blocked status badges
