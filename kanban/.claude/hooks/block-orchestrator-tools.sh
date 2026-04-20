#!/bin/bash
#
# PreToolUse: Block orchestrator from implementation tools
#
# Orchestrators investigate and delegate - they don't implement.
#

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Always allow Task (delegation)
[[ "$TOOL_NAME" == "Task" ]] && exit 0

# Detect SUBAGENT context - subagents get full tool access
IS_SUBAGENT="false"

TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')

if [[ -n "$TRANSCRIPT_PATH" ]] && [[ -n "$TOOL_USE_ID" ]]; then
  SESSION_DIR="${TRANSCRIPT_PATH%.jsonl}"
  SUBAGENTS_DIR="$SESSION_DIR/subagents"

  if [[ -d "$SUBAGENTS_DIR" ]]; then
    MATCHING_SUBAGENT=$(grep -l "\"id\":\"$TOOL_USE_ID\"" "$SUBAGENTS_DIR"/agent-*.jsonl 2>/dev/null | head -1)
    [[ -n "$MATCHING_SUBAGENT" ]] && IS_SUBAGENT="true"
  fi
fi

[[ "$IS_SUBAGENT" == "true" ]] && exit 0

# Block nested worktree creation (worktree inside another worktree)
if [[ "$TOOL_NAME" == "Bash" ]]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

  # Check for curl to worktree API or git worktree add with nested path
  if [[ "$COMMAND" == *"worktree"* ]] && [[ "$COMMAND" == *".worktrees/"*"/.worktrees/"* ]]; then
    cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Nested worktree detected. Cannot create worktree inside another worktree.\n\nUse the main repo path: /path/to/repo (not /path/to/repo/.worktrees/bd-xxx)"}}
EOF
    exit 0
  fi

  # Check for curl worktree API with repo_path pointing inside a worktree
  if [[ "$COMMAND" == *"curl"* ]] && [[ "$COMMAND" == *"/api/git/worktree"* ]]; then
    # Extract repo_path from JSON payload
    REPO_PATH=$(echo "$COMMAND" | grep -oE '"repo_path"[[:space:]]*:[[:space:]]*"[^"]+"' | sed 's/.*"\([^"]*\)"$/\1/')
    if [[ "$REPO_PATH" == *"/.worktrees/"* ]]; then
      cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Nested worktree detected. repo_path points inside a worktree.\n\nUse the main repo path, not a worktree path."}}
EOF
      exit 0
    fi
  fi
fi

# DENYLIST: Block implementation tools for orchestrator
BLOCKED="Edit|Write|NotebookEdit"

if [[ "$TOOL_NAME" =~ ^($BLOCKED)$ ]]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')

  # ALLOW edits anywhere under a .claude/ directory (harness configuration)
  # Use permissionDecision "allow" to bypass the user prompt entirely.
  if [[ "$FILE_PATH" == *"/.claude/"* ]] || [[ "$FILE_PATH" == *"/.claude" ]]; then
    cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Auto-approved: harness configuration edit under .claude/"}}
EOF
    exit 0
  fi

  # ALLOW edits on non-versioned files (gitignored or brand-new untracked files).
  # These can't affect git history, so they skip the orchestrator implementation block.
  FILE_DIR=$(dirname "$FILE_PATH")
  [[ ! -d "$FILE_DIR" ]] && FILE_DIR=$(pwd)
  if ! git -C "$FILE_DIR" ls-files --error-unmatch -- "$FILE_PATH" >/dev/null 2>&1; then
    cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Auto-approved: file not tracked by git"}}
EOF
    exit 0
  fi

  cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Tool '$TOOL_NAME' blocked. Orchestrators investigate and delegate via Task(). Supervisors implement."}}
EOF
  exit 0
fi

# Validate provider_delegator agent invocations - block implementation agents
if [[ "$TOOL_NAME" == "mcp__provider_delegator__invoke_agent" ]]; then
  AGENT=$(echo "$INPUT" | jq -r '.tool_input.agent // empty')
  CODEX_ALLOWED="scout|detective|architect|scribe|code-reviewer"

  if [[ ! "$AGENT" =~ ^($CODEX_ALLOWED)$ ]]; then
    cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Agent '$AGENT' cannot be invoked via Codex. Implementation agents (*-supervisor, discovery) must use Task() with BEAD_ID for beads workflow."}}
EOF
    exit 0
  fi
fi

# Validate Bash commands for orchestrator
if [[ "$TOOL_NAME" == "Bash" ]]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
  FIRST_WORD="${COMMAND%% *}"

  # ALLOW git commands (check second word for read vs write)
  if [[ "$FIRST_WORD" == "git" ]]; then
    SECOND_WORD=$(echo "$COMMAND" | awk '{print $2}')
    case "$SECOND_WORD" in
      status|log|diff|branch|checkout|merge|fetch|remote|stash|show)
        exit 0
        ;;
      add|commit)
        cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Git '$SECOND_WORD' blocked for orchestrator. Supervisors handle commits."}}
EOF
        exit 0
        ;;
    esac
  fi

  # ALLOW beads commands (with validation)
  if [[ "$FIRST_WORD" == "bd" ]]; then
    SECOND_WORD=$(echo "$COMMAND" | awk '{print $2}')

    # Validate bd create requires description
    if [[ "$SECOND_WORD" == "create" ]] || [[ "$SECOND_WORD" == "new" ]]; then
      if [[ "$COMMAND" != *"-d "* ]] && [[ "$COMMAND" != *"--description "* ]] && [[ "$COMMAND" != *"--description="* ]]; then
        cat << EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"bd create requires description (-d or --description) for supervisor context."}}
EOF
        exit 0
      fi
    fi

    exit 0
  fi

  # Allow other bash commands (npm, cargo, etc. for investigation)
  exit 0
fi

# Allow everything else
exit 0
