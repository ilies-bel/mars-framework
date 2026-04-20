# Dark Minimalist Theme for Kanban and Settings Pages

## Epic ID: beads-kanban-ui-qxq

## Overview

Apply the dark minimalist aesthetic from the home page to the Kanban board (project page) and Settings page. The goal is visual consistency across all pages: dark backgrounds, glass-morphism cards, subtle borders, and refined typography.

## Reference Implementation

The home page (`src/app/page.tsx`) establishes the target aesthetic:
- Root container: `dark min-h-dvh bg-[#0a0a0a]`
- Nav: `border-zinc-800 bg-[#0a0a0a]/80 backdrop-blur-sm`
- Cards: roiui glass effect with `backdrop-filter: blur(12px)`

---

## 1. Color Palette

### Background Colors

| Usage | Value | Tailwind Class |
|-------|-------|----------------|
| Page background | `#0a0a0a` | `bg-[#0a0a0a]` |
| Column background | - | `bg-zinc-900/50` |

### Border Colors

| Usage | Tailwind Class |
|-------|----------------|
| Default border | `border-zinc-800` |
| Hover border | `border-zinc-700` |
| Focus ring | `ring-zinc-400` |

### Text Colors

| Usage | Tailwind Class |
|-------|----------------|
| Primary text | `text-white` or `text-foreground` |
| Secondary text | `text-zinc-400` |
| Muted text | `text-zinc-500` |

---

## 2. Card Styling (Glass Effect)

```tsx
<div className={cn(
  "rounded-lg",
  "bg-zinc-900/70 backdrop-blur-md",
  "border border-zinc-800/60",
  "shadow-sm shadow-black/20",
  "transition-all duration-200",
  "hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/30",
  "hover:border-zinc-700"
)}>
```

### Selected State
```tsx
isSelected && "ring-2 ring-zinc-400 ring-offset-2 ring-offset-[#0a0a0a]"
```

### Blocked State
```tsx
blocked ? "border-l-4 border-l-red-500" : "border-l-4 border-l-transparent"
```

---

## 3. Column Differentiation

Use subtle colored accent bars at the top of each column header instead of colored backgrounds.

### Column Container
```tsx
<div className="flex flex-col h-full min-h-0 rounded-lg bg-zinc-900/30 border border-zinc-800/50">
```

### Column Color Mapping

| Status | Accent Border | Header Text | Badge BG | Badge Text |
|--------|---------------|-------------|----------|------------|
| Open | `border-t-blue-500/60` | `text-blue-400` | `bg-blue-500/20` | `text-blue-400` |
| In Progress | `border-t-amber-500/60` | `text-amber-400` | `bg-amber-500/20` | `text-amber-400` |
| In Review | `border-t-purple-500/60` | `text-purple-400` | `bg-purple-500/20` | `text-purple-400` |
| Closed | `border-t-green-500/60` | `text-green-400` | `bg-green-500/20` | `text-green-400` |

---

## 4. Badge Colors (Dark Theme)

### Priority Badges

| Priority | Background | Text |
|----------|------------|------|
| P0 (Critical) | `bg-red-500/20` | `text-red-400` |
| P1 (High) | `bg-orange-500/20` | `text-orange-400` |
| P2 (Medium) | `bg-zinc-500/20` | `text-zinc-400` |
| P3/P4 (Low) | `bg-zinc-600/20` | `text-zinc-500` |

### Status Badges

| Status | Background | Text |
|--------|------------|------|
| BLOCKED | `bg-red-500/20` | `text-red-400` |
| Open | `bg-blue-500/20` | `text-blue-400` |
| In Progress | `bg-amber-500/20` | `text-amber-400` |
| In Review | `bg-purple-500/20` | `text-purple-400` |
| Closed | `bg-green-500/20` | `text-green-400` |

---

## 5. Page Wrapper Pattern

### Kanban Page
```tsx
<div className="dark min-h-dvh bg-[#0a0a0a]">
  <header className="sticky top-0 z-30 border-b border-zinc-800 bg-[#0a0a0a]/80 backdrop-blur-sm px-4 py-3">
  </header>
  <main className="flex-1 overflow-hidden p-4">
  </main>
</div>
```

### Settings Page
```tsx
<div className="dark min-h-dvh bg-[#0a0a0a]">
  <header className="sticky top-0 z-30 border-b border-zinc-800 bg-[#0a0a0a]/80 backdrop-blur-sm px-6 py-4">
  </header>
  <main className="mx-auto max-w-2xl p-6">
  </main>
</div>
```

---

## 6. Button Variants

| Variant | Classes |
|---------|---------|
| Primary | `bg-zinc-100 text-zinc-900 hover:bg-white` |
| Ghost | `text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100` |
| Destructive | `bg-red-900/30 text-red-400 border-red-800/50 hover:bg-red-900/50` |
