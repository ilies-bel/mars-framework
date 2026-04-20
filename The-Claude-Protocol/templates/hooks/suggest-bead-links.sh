#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
#
# PostToolUse:Bash (timeout 10s) — Auto-link new beads to explicit prerequisite references
#
# Fires after every Bash tool use. Bails immediately if the command was not
# `bd create`. When a new bead is created:
#
#  1. DETERMINISTIC: scan description for explicit <prefix>-XXX references →
#     auto-run `bd dep add <new> <ref>` for each open/in_progress referenced bead.
#     Logs AUTO-LINKED comment. No skill reminder emitted (high-confidence path).
#
#  2. SEMANTIC FALLBACK: if no high-confidence auto-link was made, emit a
#     <system-reminder> asking Claude to invoke the bead-link-suggest skill.
#
# Prefix-agnostic: derives the project prefix at runtime from the newly created
# bead ID, so the same hook works for any beads database (gustave-*, bd-*, etc.).

INPUT=$(cat)

# ── Guard: only process Bash tool ─────────────────────────────────────────────
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
[[ "$TOOL_NAME" != "Bash" ]] && exit 0

# ── Guard: only fire on bd create commands ────────────────────────────────────
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
[[ "$CMD" != *"bd create"* ]] && exit 0

# ── Parse new bead ID from stdout ─────────────────────────────────────────────
STDOUT=$(printf '%s' "$INPUT" | jq -r '.tool_response.stdout // ""' 2>/dev/null)
NEW_ID=$(printf '%s' "$STDOUT" | grep -oE 'Created issue: [^[:space:]]+' | head -1 | awk '{print $3}')
[[ -z "$NEW_ID" ]] && exit 0

# ── Derive project prefix from the new bead ID ────────────────────────────────
# "gustave-09n.4" → "gustave", "bd-42" → "bd"
PREFIX="${NEW_ID%%-*}"
[[ -z "$PREFIX" || "$PREFIX" == "$NEW_ID" ]] && exit 0

# ── Extract description from the bd create command ────────────────────────────
# Handle both single-quoted and double-quoted -d / --description values (BSD sed)
DESC=$(printf '%s' "$CMD" | sed -n "s/.*-d[[:space:]]*'\([^']*\)'.*/\1/p" | head -1)
if [[ -z "$DESC" ]]; then
  DESC=$(printf '%s' "$CMD" | sed -n 's/.*-d[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi

# ── Find explicit <prefix>-XXX references in the description ─────────────────
REFS=$(printf '%s' "$DESC" | grep -oE "${PREFIX}-[a-z0-9.]+" | sort -u)

LINKED=0

for REF in $REFS; do
  # Skip self-reference
  [[ "$REF" == "$NEW_ID" ]] && continue

  # Check that referenced bead exists and is open or in_progress
  REF_STATUS=$(bd show "$REF" --json 2>/dev/null | jq -r '.[0].status // empty' 2>/dev/null || true)
  [[ "$REF_STATUS" != "open" && "$REF_STATUS" != "in_progress" ]] && continue

  # Auto-link: new bead depends on referenced bead (only comment when dep actually succeeds)
  if bd dep add "$NEW_ID" "$REF" 2>/dev/null; then
    bd comments add "$NEW_ID" "AUTO-LINKED: depends on $REF — explicit reference in description" 2>/dev/null || true
    LINKED=$((LINKED + 1))
  fi
done

# ── Semantic fallback: emit reminder only when no high-confidence link found ──
if [[ "$LINKED" -eq 0 ]]; then
  printf '<system-reminder>No explicit bead reference found in the new bead description. Invoke the bead-link-suggest skill to check for semantic links: Skill(skill: "bead-link-suggest") with new bead ID: %s</system-reminder>\n' "$NEW_ID"
fi

exit 0
