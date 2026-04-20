# Kanban UI Connection Descriptor (`.beads/kanban.json`)

## Purpose

Modern `beads` uses Dolt (a git-backed, MySQL-wire-compatible database) as its only supported storage backend. The legacy `.beads/issues.jsonl` file is no longer authoritative — if it exists at all, it is either a manual export or a stale artifact.

`bootstrap.py` emits `.beads/kanban.json` so the Beads Kanban UI can connect directly to the Dolt server instead of tailing the obsolete JSONL file.

## File location

```
<project>/.beads/kanban.json
```

Tracked? **No.** `.beads/` is in `.gitignore` (ephemeral, per-machine state).

## Schema

```json
{
  "backend": "dolt",
  "host": "127.0.0.1",
  "port": 56621,
  "user": "root",
  "passwordEnv": "BEADS_DOLT_PASSWORD",
  "database": "myproject",
  "branch": "main",
  "generatedBy": "bootstrap.py",
  "generatedAt": "2026-04-15T08:22:10Z"
}
```

| Field          | Meaning                                                                 |
|----------------|-------------------------------------------------------------------------|
| `backend`      | Always `"dolt"` today. Reserved for future alternatives.                |
| `host`         | Always `127.0.0.1` — beads only runs Dolt locally.                      |
| `port`         | Read from `~/.beads/dolt-server.port`. Rotates when Dolt restarts.      |
| `user`         | Dolt superuser — always `root` with the stock beads install.            |
| `passwordEnv`  | Name of the env var the UI should read to get the password. **Never embed the password itself.** |
| `database`     | Per-project Dolt database. Sourced from `.beads/config.yaml`, fallback is a slug of the project name. |
| `branch`       | Dolt branch — `main` by default.                                        |
| `generatedBy`  | Tool that wrote the file (audit trail).                                 |
| `generatedAt`  | ISO-8601 UTC timestamp.                                                 |

## How the Kanban UI should consume it

```js
const cfg = JSON.parse(fs.readFileSync('.beads/kanban.json', 'utf8'));
const connection = await mysql.createConnection({
  host: cfg.host,
  port: cfg.port,
  user: cfg.user,
  password: process.env[cfg.passwordEnv] ?? '',
  database: cfg.database,
});
```

Do **not** fall back to reading `.beads/issues.jsonl` if the config is missing. Instead, surface a visible error telling the user to re-run bootstrap.

## Regenerating after a Dolt restart

Dolt picks a fresh port on each restart. The fastest way to refresh the descriptor:

```bash
# From any project directory
npx beads-orchestration regen-kanban-config --project-dir . --project-name "My Proj"
```

`--project-name` is optional — falls back to `package.json#name`, then the directory name.

Fallback if `npx` isn't available:

```bash
python3 -c "
import sys; sys.path.insert(0, '/path/to/The-Claude-Protocol')
from bootstrap import write_kanban_config
from pathlib import Path
write_kanban_config(Path('.'), 'your project name')
"
```

## Troubleshooting

| Symptom                                   | Diagnosis                                      |
|-------------------------------------------|------------------------------------------------|
| `kanban.json` missing after bootstrap     | `~/.beads/dolt-server.port` is absent — run `bd doctor` then re-bootstrap. |
| UI connects but sees no tasks             | Wrong `database` — check `.beads/config.yaml`'s `database:` key. |
| UI gets "access denied"                   | `BEADS_DOLT_PASSWORD` env var not set where the UI runs. |
| Port in `kanban.json` no longer works     | Dolt restarted; regenerate the config (see above). |
