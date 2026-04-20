#!/bin/bash
#
# PreToolUse(Bash): Block shell commands that have native-tool equivalents.
#
# Native tools (Glob, Read, Grep, direct text output) are strictly cheaper:
# no shell startup, no permission/sandbox layer, no full-context cache
# reload triggered just to list a directory or cat a file. Rule of thumb
# from token analysis: a bare `ls` or `cat` costs ~110K tokens of cached
# context re-reading on each call.
#
# Only the FIRST token is inspected (after stripping rtk/sudo/env wrappers).
# So `git log | grep foo` is allowed — `grep` in a pipeline has no native
# equivalent and is legitimate. Only standalone `grep X .` is blocked.
#
# `cd` is intentionally NOT blocked — supervisors (subagents) `cd` into their
# assigned worktree at entry. The orchestrator itself uses `git -C <path>` and
# does not `cd`; see CLAUDE.md Post-Task Merge Protocol.
#

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

[[ "$TOOL_NAME" != "Bash" ]] && exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[[ -z "$COMMAND" ]] && exit 0

# Strip leading wrappers. `rtk proxy` is its own special prefix.
STRIPPED="$COMMAND"
# trim leading whitespace
STRIPPED="${STRIPPED#"${STRIPPED%%[![:space:]]*}"}"
while :; do
  case "$STRIPPED" in
    "rtk proxy "*) STRIPPED="${STRIPPED#rtk proxy }" ;;
    "rtk "*)       STRIPPED="${STRIPPED#rtk }" ;;
    "sudo "*)      STRIPPED="${STRIPPED#sudo }" ;;
    "env "*)       STRIPPED="${STRIPPED#env }" ;;
    "time "*)      STRIPPED="${STRIPPED#time }" ;;
    "command "*)   STRIPPED="${STRIPPED#command }" ;;
    "exec "*)      STRIPPED="${STRIPPED#exec }" ;;
    *) break ;;
  esac
  STRIPPED="${STRIPPED#"${STRIPPED%%[![:space:]]*}"}"
done

# First token only
FIRST="${STRIPPED%%[[:space:]]*}"

case "$FIRST" in
  ls|find)
    REASON=$'Blocked: `'"$FIRST"$'` via Bash.\n\nUse the Glob tool instead — faster, no shell overhead, no full-context cache reload.\n  Glob(pattern="**/*.ts")\n  Glob(pattern="design/*.pen")\n  Glob(pattern="src/components/*.tsx")\n\nGlob returns paths sorted by mtime and accepts any glob pattern.'
    ;;
  cat|head|tail)
    REASON=$'Blocked: `'"$FIRST"$'` via Bash.\n\nUse the Read tool instead — supports line ranges (like head/tail), images, PDFs, and notebooks.\n  Read(file_path="/abs/path/to/file")\n  Read(file_path="...", offset=100, limit=50)   # head/tail equivalent\n\nNo shell overhead, no cache-reload tax.'
    ;;
  grep)
    REASON=$'Blocked: standalone `grep` via Bash.\n\nUse the Grep tool instead — structured output, head-limited, much cheaper.\n  Grep(pattern="foo", output_mode="files_with_matches")\n  Grep(pattern="foo", glob="*.ts", output_mode="content", -n=true)\n\nNote: `grep` INSIDE a pipeline (e.g. `git log | grep X`) is allowed — only standalone grep is blocked, because filtering another command\'s output is the one case native Grep can\'t handle.'
    ;;
  echo)
    # Allow `echo` when it's part of a compound command (pipeline, chain, redirection,
    # command substitution). Standalone `echo "hi"` stays blocked — that's pure waste
    # because the model already has the string.
    # Strip quoted content so we don't mistake `echo "foo | bar"` for a real pipeline.
    ECHO_STRIPPED=$(printf '%s' "$COMMAND" | sed -E "s/'[^']*'//g" | sed -E 's/"[^"]*"//g')
    if printf '%s' "$ECHO_STRIPPED" | grep -qE '(\||&&|\|\||;|>|<|\$\()'; then
      exit 0
    fi
    REASON=$'Blocked: standalone `echo` via Bash.\n\nTo communicate with the user, just output text directly — no tool call needed.\nTo create file content, use the Write tool.\nTo template a value into another command, embed it directly in that command.\n\nNote: `echo` INSIDE a compound command (pipeline, `&&` chain, redirection, or `$(...)`) is allowed — only standalone `echo "foo"` is blocked. Example allowed: `echo "{...}" | jq .`, `echo "$X" > file`, `echo "{...}" | .claude/hooks/foo.sh`.'
    ;;
  *) exit 0 ;;
esac

jq -n --arg reason "$REASON" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
exit 0
