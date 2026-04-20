---
name: commit
description: Stage changes, create commit with conventional commit message, and record for later push
user-invocable: true
---

# Git Commit

Create a clean, one-line conventional commit for current changes. No Co-Author trailer.

## Steps

1. Run in parallel:
   - `git status` (never use `-uall`)
   - `git diff --staged` and `git diff` to see all changes
   - `git log --oneline -5` to match existing commit style

2. Analyze all staged + unstaged changes. Determine:
   - Type: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `style`, `perf`, `ci`, `build`
   - Optional scope in parentheses if changes are localized (e.g., `feat(auth):`)
   - Short imperative description (max ~72 chars total)

3. Stage relevant files by name (never `git add -A` or `git add .`). Skip files that look like secrets (`.env`, credentials, keys).

4. Commit with a single-line message using a heredoc:

```bash
git commit -m "$(cat <<'EOF'
type(scope): short imperative description
EOF
)"
```

5. Run `git status` to confirm success.

## Rules

- **One line only.** No body, no trailers, no Co-Author.
- **Conventional commits** format: `type(scope): description`
- **Imperative mood**: "add", "fix", "update" — not "added", "fixes", "updated"
- **Lowercase** everything after the type prefix
- **No period** at the end
- If there are no changes to commit, say so and stop
- Never push unless explicitly asked
