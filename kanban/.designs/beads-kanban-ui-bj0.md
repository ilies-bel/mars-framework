# Main Page Design Overhaul

## Epic ID: beads-kanban-ui-bj0

## Overview

Modernize the main projects page with an animated beam background, custom typography, and improved layout structure. Remove navbar, add centered heading, create a visually appealing project grid.

## Requirements

1. **Background**: Animated Beams component from @react-bits registry
   - Full-screen, fixed position, behind all content
   - Config: beamWidth=8, beamHeight=14, beamNumber=20, lightColor="#f0c7ff", speed=2, noiseIntensity=1.75, scale=0.2, rotation=30

2. **Typography**: Space Grotesk font family
   - Imported via next/font/google
   - Applied to headings

3. **Layout**:
   - Remove navbar/header completely
   - Add centered heading: "Manage Your Beads Projects"
   - Center the 3-column grid with max-width constraint (~1200px)
   - Keep FAB button for adding projects
   - Move settings icon to top-right corner (fixed position)

## Visual Layout

```
+--------------------------------------------------+
|  [Settings Icon]                          (fixed)|
|                                                  |
|        "Manage Your Beads Projects"              |
|        (Space Grotesk, centered)                 |
|                                                  |
|    +-------+  +-------+  +-------+               |
|    | Card  |  | Card  |  | Card  |               |
|    +-------+  +-------+  +-------+               |
|                                                  |
|                              [+ FAB]     (fixed) |
+--------------------------------------------------+
  * Animated Beams fill entire viewport behind *
```

## Z-Index Layering

| Layer | z-index | Component |
|-------|---------|-----------|
| Background | 0 | Beams |
| Content | 10 | Main container, grid, cards |
| Controls | 20 | FAB, Settings icon |
| Dialogs | 50 | AddProjectDialog |

## Implementation Tasks

1. **beads-kanban-ui-bj0.1**: Install Beams component
   - `npx shadcn@latest add @react-bits/Beams-JS-CSS`

2. **beads-kanban-ui-bj0.2**: Configure Space Grotesk font
   - Add to layout.tsx via next/font/google
   - Add .font-heading utility class

3. **beads-kanban-ui-bj0.3**: Restructure main page layout
   - Remove header, add Beams background, add heading, center grid
   - Depends on tasks 1 and 2

## File Changes

| File | Change |
|------|--------|
| src/app/page.tsx | Remove navbar, add Beams, add heading, center layout |
| src/app/layout.tsx | Add Space Grotesk font |
| src/app/globals.css | Add .font-heading class |
| src/components/ui/beams.tsx | New file (from registry) |
