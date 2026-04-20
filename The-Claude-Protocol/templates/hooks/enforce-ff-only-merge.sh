#!/bin/bash
#
# PreToolUse(Bash): Block non-fast-forward merges into main/master.
#
# Post-Task Merge Protocol requires:
#   1. rebase bd-{ID} onto main
#   2. git merge --ff-only bd-{ID}
#
# A merge without --ff-only (or with --no-ff, --squash) would create a merge
# commit, which defeats the rebase-and-FF strategy. This hook is the safety net.
#

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

[[ "$TOOL_NAME" != "Bash" ]] && exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Strip quoted content so `git merge` inside commit messages, echo strings, or
# heredocs doesn't false-positive. Best-effort: collapse newlines, then remove
# single-quoted and double-quoted substrings.
STRIPPED=$(printf '%s' "$COMMAND" | tr '\n' ' ' | sed -E "s/'[^']*'//g" | sed -E 's/"[^"]*"//g')

# Only inspect real `git merge` invocations
if ! echo "$STRIPPED" | grep -qE '(^|[^[:alnum:]._-])git[[:space:]]+merge([[:space:]]|$)'; then
  exit 0
fi

# Must be on main/master for this rule to apply
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)
if [[ "$CURRENT_BRANCH" != "main" && "$CURRENT_BRANCH" != "master" ]]; then
  exit 0
fi

# Allow benign subcommands that happen to start with `git merge` but aren't a merge
# (e.g. `git merge-base`, `git merge-file`)
if echo "$COMMAND" | grep -qE 'git[[:space:]]+merge-(base|file|tree|index)'; then
  exit 0
fi

# Allow rebase-continue-style flows and aborts
if echo "$COMMAND" | grep -qE 'git[[:space:]]+merge[[:space:]]+--abort'; then
  exit 0
fi

# Deny any merge that is explicitly non-FF or squash
if echo "$COMMAND" | grep -qE '(--no-ff|--squash)'; then
  cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked: non-fast-forward merge to $CURRENT_BRANCH.\n\nPost-Task Merge Protocol requires --ff-only merges to main.\nRebase the branch first, then:\n  git merge --ff-only <branch>"}}
EOF
  exit 0
fi

# Require --ff-only to be present
if ! echo "$COMMAND" | grep -qE '(--ff-only)'; then
  cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked: git merge to $CURRENT_BRANCH without --ff-only.\n\nPost-Task Merge Protocol (CLAUDE.md) — orchestrator stays in main checkout:\n  1. git -C .worktrees/bd-{ID} rebase main\n  2. git merge --ff-only bd-{ID}   # already on main, no cd needed\n\nIf the branch is not fast-forwardable, rebase it first."}}
EOF
  exit 0
fi

exit 0
