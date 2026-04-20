#!/bin/bash
#
# PreToolUse: Force use of the /commit skill for git commit commands.
#
# The `commit` skill (shipped in .claude/skills/commit/SKILL.md) produces
# one-line conventional commit messages with no body and no trailers.
# This hook denies any git commit that does not follow those conventions
# and tells the agent to invoke `Skill(skill: "commit")` instead.
#
# Conventions enforced (match the skill's output):
#   - Conventional prefix: feat|fix|refactor|chore|docs|test|style|perf|ci|build
#     optionally followed by a scope in parentheses, then ": description"
#   - Single-line message (no multi-line body)
#   - No Co-Authored-By trailer
#   - No "Generated with Claude Code" / robot marker trailer
#
# Commits authored via the skill pass through unchanged.
#

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only inspect Bash commands
[[ "$TOOL_NAME" != "Bash" ]] && exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Fast path: no `git commit` in the command → ignore
if ! echo "$COMMAND" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*commit([[:space:]]|$)'; then
  exit 0
fi

# Allow informational subcommands that aren't actually creating commits
# (git log, git commit-tree used in plumbing, etc.) — the regex above
# already restricts to `git commit` proper, so nothing else to skip.

deny() {
  local reason="$1"
  # Escape for JSON
  reason_escaped=$(printf '%s' "$reason" | jq -Rs .)
  cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":${reason_escaped}}}
EOF
  exit 0
}

SKILL_INSTRUCTION='Direct `git commit` is blocked. Use the commit skill instead:

    Skill(skill: "commit")

The skill produces one-line conventional commits (no body, no Co-Author trailer).

Rejected because: %s

Skill rules:
  - Format: type(scope): short imperative description
  - Types: feat, fix, refactor, chore, docs, test, style, perf, ci, build
  - One line only — no body, no trailers, no Co-Authored-By
  - Lowercase after the type prefix, no trailing period'

# Reject commits with Co-Author trailer (skill forbids it)
if echo "$COMMAND" | grep -qiE 'Co-Authored-By:'; then
  deny "$(printf "$SKILL_INSTRUCTION" "commit message contains a Co-Authored-By trailer")"
fi

# Reject commits with the robot / generated trailer
if echo "$COMMAND" | grep -qE '(Generated with \[?Claude Code|🤖)'; then
  deny "$(printf "$SKILL_INSTRUCTION" "commit message contains a 'Generated with Claude Code' trailer")"
fi

# Extract the -m message payload(s). Handle common shapes:
#   git commit -m "..."
#   git commit -m "$(cat <<'EOF' ... EOF)"
#   git commit -m "line1\nline2"
#
# We only inspect the *first* -m argument; additional -m flags imply a body
# and are disallowed by the skill.
M_FLAG_COUNT=$(echo "$COMMAND" | grep -oE '(^|[[:space:]])-m([[:space:]]|=)' | wc -l | tr -d ' ')
if [[ "${M_FLAG_COUNT:-0}" -gt 1 ]]; then
  deny "$(printf "$SKILL_INSTRUCTION" "multiple -m flags produce a multi-line commit body")"
fi

# Reject -F/--file (cannot statically validate contents, encourages bodies)
if echo "$COMMAND" | grep -qE '(^|[[:space:]])(-F|--file)([[:space:]]|=)'; then
  deny "$(printf "$SKILL_INSTRUCTION" "-F/--file is not used by the commit skill")"
fi

# Reject amends (skill creates new commits, never amends)
if echo "$COMMAND" | grep -qE '(^|[[:space:]])--amend([[:space:]]|$)'; then
  deny "$(printf "$SKILL_INSTRUCTION" "--amend is forbidden; create a new commit via the skill")"
fi

# Extract the first -m message payload to validate single-line + conventional prefix.
# Strategy: use python for robust parsing because bash quoting here is fragile.
MESSAGE=$(python3 - <<'PY' "$COMMAND" 2>/dev/null
import re, sys, shlex

cmd = sys.argv[1]

# Resolve heredoc substitutions of the form: "$(cat <<'EOF' ... EOF)" or <<EOF
def resolve_heredocs(s: str) -> str:
    # $(cat <<'TAG' ... TAG) or $(cat <<TAG ... TAG)
    pattern = re.compile(r"\$\(\s*cat\s*<<-?'?([A-Za-z_][A-Za-z0-9_]*)'?\s*\n(.*?)\n\s*\1\s*\)", re.DOTALL)
    while True:
        m = pattern.search(s)
        if not m:
            break
        s = s[:m.start()] + m.group(2) + s[m.end():]
    return s

cmd = resolve_heredocs(cmd)

# Now find the first -m argument's value.
# Try shlex first; fall back to a regex if shlex fails on complex quoting.
try:
    tokens = shlex.split(cmd, posix=True)
except ValueError:
    tokens = None

msg = None
if tokens:
    for i, tok in enumerate(tokens):
        if tok == "-m" and i + 1 < len(tokens):
            msg = tokens[i + 1]
            break
        if tok.startswith("-m") and len(tok) > 2:
            msg = tok[2:]
            break
        if tok.startswith("--message="):
            msg = tok[len("--message="):]
            break

if msg is None:
    # Regex fallback: capture content between quotes after -m
    m = re.search(r'-m\s+"((?:[^"\\]|\\.)*)"', cmd)
    if m:
        msg = m.group(1)

if msg is None:
    # No message could be parsed — let the commit proceed; git will error if truly malformed.
    sys.exit(0)

# Strip trailing blank lines that git would ignore anyway
msg = msg.strip("\n")
print(msg, end="")
PY
)

# If parsing failed we bail out permissively — better to let git surface the error
if [[ -z "$MESSAGE" ]]; then
  exit 0
fi

# Reject multi-line messages (body present)
if [[ "$MESSAGE" == *$'\n'* ]]; then
  deny "$(printf "$SKILL_INSTRUCTION" "commit message spans multiple lines; skill requires a single line")"
fi

# Enforce conventional commit prefix
CONVENTIONAL_RE='^(feat|fix|refactor|chore|docs|test|style|perf|ci|build)(\([^)]+\))?: .+'
if ! printf '%s' "$MESSAGE" | grep -Eq "$CONVENTIONAL_RE"; then
  deny "$(printf "$SKILL_INSTRUCTION" "commit message is not conventional (expected 'type(scope): description')")"
fi

# Reject trailing period
if printf '%s' "$MESSAGE" | grep -Eq '\.$'; then
  deny "$(printf "$SKILL_INSTRUCTION" "commit message ends with a period")"
fi

# All skill conventions satisfied — allow the commit through
exit 0
