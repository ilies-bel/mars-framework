# Design Specification: Beads Kanban UI Modernization
## Implementation Guide for Shadcn UI Registries

This document outlines the visual and structural changes required to modernize the Beads Kanban interface using specific Shadcn UI registry components and design patterns.

---

### 1. Unified Card Hierarchy (Priority: High)
* **Component Structure:** * **Root:** `Card` with `variant="outline"`. Remove shadow; use a subtle border (`border-border/40`).
    * **Header:** `CardHeader` containing two rows. 
        * Row 1: `CardDescription` for the ID (#106) and a `Badge` (variant="outline") for the Task Type (Task/Epic).
        * Row 2: `CardTitle` with font-weight `font-semibold` and size `text-sm`.
    * **Footer:** `CardFooter` with `gap-2` and `text-muted-foreground`. 
* **Design Intent:** Standardizes the "scan-path" so users always find the ID top-left and the type top-right.

### 2. Status Column "Empty States" (Priority: High)
* **Component Structure:** * A `div` container with `border-2 border-dashed rounded-lg`.
    * **Center:** `Lucide Icon` (e.g., `PackageOpen`) followed by a small label.
    * **Action:** `Button` (variant="ghost", size="sm") with the text "Create task".
* **Design Intent:** Replaces "No beads" text with an interactive placeholder that eliminates "dead space" and encourages user action.

### 3. Epic Progress Visualization (Priority: High)
* **Component Structure:** * **Label Row:** A `flex` container using `Label` for "Progress" and a span for "100%" (size `text-[10px]`).
    * **Bar:** `Progress` component.
* **Styling:** * Height: Set to `h-1.5` (6px) for a modern, sleek look.
    * Color: Use a custom background for the indicator (e.g., `bg-purple-500`) to visually separate Epics from standard tasks.
* **Design Intent:** Provides a technical, high-density look that doesn't overwhelm the card's primary text.

### 4. Interactive Column Headers (Priority: Medium)
* **Component Structure:** * **Left:** `Badge` or `Label` for the Status name.
    * **Right:** `Button` (variant="ghost", size="icon") using the `Plus` icon.
* **Design Intent:** Reduces friction by allowing users to add a task directly into a specific workflow state (e.g., "In Review") without a global modal.

### 5. Type-Based Color Accents (Priority: Medium)
* **Component Structure:** `Badge` variants.
    * **Task:** `variant="secondary"` with a blue tint icon.
    * **Epic:** `variant="default"` (solid) with a purple tint.
* **Secondary Detail:** Apply a `border-l-2` to the `Card` component itself, color-coded to the task type (Blue for Task, Purple for Epic).
* **Design Intent:** Enables peripheral recognition of work categories without needing to read the text tags.

### 6. Card Density & Padding (Priority: Medium)
* **Component Structure:** `Card` utility classes.
    * Reduce `CardHeader` and `CardContent` padding to `p-3` or `p-4`.
    * Use `space-y-1.5` for internal stacking.
* **Design Intent:** Increases the "Information Density," allowing more cards to be visible on the screen simultaneously—crucial for kanban overview.

### 7. Filter Bar Sophistication (Priority: Medium)
* **Component Structure:** `Tabs` or `ToggleGroup`.
    * Use `TabsList` as a container for "All," "Epics," "Tasks," and "Today."
    * `TabsTrigger` (variant="underline" or "pill").
* **Design Intent:** Replaces chunky standalone buttons with a unified navigation element that feels like a native OS control.

### 8. Global Search & Action Styling (Priority: Low)
* **Component Structure:** `Input` combined with a `Shortcut` component.
    * Input left-element: `Search` icon.
    * Input right-element: `Kbd` component (from community registry) displaying "⌘ K".
* **Design Intent:** Professionalizes the search experience, signaling keyboard-first accessibility for power users.

### 9. Subtle Column Backgrounds (Priority: Low)
* **Component Structure:** Column wrapper `div`.
    * Apply `bg-muted/30` or `bg-secondary/20`.
    * Ensure the `Card` background remains slightly lighter or solid `bg-card` to create a "lifted" effect.
* **Design Intent:** Visually groups tasks within their status "bucket," preventing the board from looking like one giant flat surface.