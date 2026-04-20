#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const command = args[0];

const packageDir = path.dirname(__dirname);
const bootstrapScript = path.join(packageDir, 'bootstrap.py');

function showHelp() {
  console.log(`
beads-orchestration - Multi-agent orchestration for Claude Code

Usage:
  beads-orchestration <command> [options]

Commands:
  install                Copy the skill to ~/.claude/ (no bootstrap)
  setup                  Non-interactive: install skill + run bootstrap in CWD
  bootstrap              Run bootstrap.py directly (advanced)
  regen-kanban-config    Rewrite .beads/kanban.json (useful after Dolt restarts)
  help                   Show this help message

Examples:
  beads-orchestration setup                                  # zero-interaction install for CWD
  beads-orchestration setup --project-dir /path/to/project
  beads-orchestration bootstrap --project-dir .
  beads-orchestration regen-kanban-config --project-dir . --project-name "My Proj"

After 'setup', restart Claude Code and run /create-beads-orchestration to trigger discovery.
`);
}

function runInstall() {
  const postinstall = path.join(__dirname, 'postinstall.js');
  require(postinstall);
}

function runBootstrap() {
  const bootstrapArgs = args.slice(1).join(' ');
  try {
    execSync(`python3 "${bootstrapScript}" ${bootstrapArgs}`, { stdio: 'inherit' });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

function runSetup() {
  const rest = args.slice(1);
  const flags = parseFlags(rest);
  const projectDir = path.resolve(flags['--project-dir'] || process.cwd());
  const kanbanDetected = (() => {
    try {
      execSync('command -v bead-kanban', { stdio: 'ignore' });
      return true;
    } catch (_) {
      return false;
    }
  })();

  // 1. Copy skill to ~/.claude/skills/
  require(path.join(__dirname, 'postinstall.js'));

  // 2. Build bootstrap invocation with sensible non-interactive defaults.
  // bootstrap.py infers claude-only mode from the absence of --external-providers
  // (see `claude_only = not args.external_providers` in bootstrap.py), so we do
  // NOT pass --claude-only here — it is not a defined argparse flag.
  const bootstrapArgs = ['--project-dir', projectDir];
  if (rest.includes('--external-providers')) {
    bootstrapArgs.push('--external-providers');
  }
  if (kanbanDetected || rest.includes('--with-kanban-ui')) {
    bootstrapArgs.push('--with-kanban-ui');
  }
  if (flags['--project-name']) {
    bootstrapArgs.push('--project-name', flags['--project-name']);
  }

  const quoted = bootstrapArgs.map(a => `"${a}"`).join(' ');
  try {
    execSync(`python3 "${bootstrapScript}" ${quoted}`, { stdio: 'inherit' });
  } catch (err) {
    process.exit(err.status || 1);
  }

  console.log('\nNext: restart Claude Code, then run /create-beads-orchestration to run discovery.');
}

function parseFlags(rest) {
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--project-dir' || flag === '--project-name') {
      out[flag] = rest[i + 1];
      i++;
    }
  }
  return out;
}

function runRegenKanbanConfig() {
  const flags = parseFlags(args.slice(1));
  const projectDir = path.resolve(flags['--project-dir'] || process.cwd());
  let projectName = flags['--project-name'];

  if (!projectName) {
    const pkgPath = path.join(projectDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        projectName = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name;
      } catch (_) {
        // fall through to basename
      }
    }
    projectName = projectName || path.basename(projectDir);
  }

  const pyScript = [
    'import sys',
    `sys.path.insert(0, r"${packageDir}")`,
    'from pathlib import Path',
    'from bootstrap import write_kanban_config',
    `ok = write_kanban_config(Path(r"${projectDir}"), r"""${projectName.replace(/"""/g, '"')}""")`,
    'sys.exit(0 if ok else 2)'
  ].join('\n');

  try {
    execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`, { stdio: 'inherit' });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

switch (command) {
  case 'install':
    runInstall();
    break;
  case 'setup':
    runSetup();
    break;
  case 'bootstrap':
    runBootstrap();
    break;
  case 'regen-kanban-config':
    runRegenKanbanConfig();
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    showHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
}
