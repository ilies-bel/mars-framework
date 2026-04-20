#!/usr/bin/env node

/**
 * Agentifind - Codebase Intelligence for AI Agents
 *
 * Extracts code structure and validates code quality to produce
 * a codebase.json that AI agents can use for navigation.
 *
 * Commands:
 *   sync   - Extract code structure and validate (outputs .claude/codebase.json)
 *   status - Check if codebase.json is stale
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

// Import types
import type {
  CodebaseIndex,
  ModuleInfo,
  ClassInfo,
  FunctionInfo,
  ValidationReport,
  IndexStats,
  StructureIndex,
  AnalysisGaps,
  InfrastructureIndex,
  InfraResource,
  InfraModule,
  InfraVariable,
  InfraOutput,
  BlastRadius,
} from './types.js';

// Import analyzers
import { StructureAnalyzer } from './analyzers/structure.js';
import { extractWithLSP } from './lsp/index.js';
import { detectAnalysisGaps, summarizeGaps } from './analyzers/anomaly-detector.js';

// Import Terraform parser
import {
  parseTerraformDirectory,
  parseTerraformDirectoryWithLSP,
  hasTerraformFiles,
  type TerraformParseResult,
} from './parsers/terraform.js';

// =============================================================================
// Console Colors for CLI Output
// =============================================================================

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(message: string, color?: keyof typeof colors): void {
  if (color) {
    console.log(`${colors[color]}${message}${colors.reset}`);
  } else {
    console.log(message);
  }
}

function logStep(step: string, total: string, message: string): void {
  console.log(`${colors.cyan}[${step}/${total}]${colors.reset} ${message}`);
}

function logSuccess(message: string): void {
  console.log(`${colors.green}[OK]${colors.reset} ${message}`);
}

function logError(message: string): void {
  console.error(`${colors.red}[ERROR]${colors.reset} ${message}`);
}

function logWarning(message: string): void {
  console.log(`${colors.yellow}[WARN]${colors.reset} ${message}`);
}

/**
 * Format bytes to human-readable size (KB, MB, GB)
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  } else {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  }
}

/**
 * Format number with commas for readability
 */
function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Get current git commit hash
 */
function getGitCommit(repoPath: string): string | null {
  try {
    const result = execSync('git rev-parse --short HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Get list of files changed since a timestamp
 */
function getChangedFilesSince(repoPath: string, since: string): string[] {
  try {
    // Use find to get files modified after the timestamp
    const sinceDate = new Date(since);
    const changedFiles: string[] = [];

    // Walk the directory and check mtime
    function walkDir(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip hidden dirs and common excludes
        if (entry.name.startsWith('.') ||
            entry.name === 'node_modules' ||
            entry.name === '__pycache__' ||
            entry.name === 'dist' ||
            entry.name === 'build') {
          continue;
        }

        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          const stats = fs.statSync(fullPath);
          if (stats.mtime > sinceDate) {
            changedFiles.push(path.relative(repoPath, fullPath));
          }
        }
      }
    }

    walkDir(repoPath);
    return changedFiles;
  } catch {
    return [];
  }
}

/**
 * Compute checksum of source files for staleness detection
 */
function computeSourceChecksum(repoPath: string, languages: string[]): string {
  const hash = crypto.createHash('sha256');

  const extensions: Record<string, string[]> = {
    python: ['.py'],
    typescript: ['.ts', '.tsx'],
    javascript: ['.js', '.jsx'],
  };

  const allowedExts = new Set<string>();
  for (const lang of languages) {
    const exts = extensions[lang] || [];
    for (const ext of exts) {
      allowedExts.add(ext);
    }
  }

  function walkDir(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip hidden dirs and common excludes
        if (entry.name.startsWith('.') ||
            entry.name === 'node_modules' ||
            entry.name === '__pycache__' ||
            entry.name === 'dist' ||
            entry.name === 'build') {
          continue;
        }

        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (allowedExts.has(ext)) {
            const stats = fs.statSync(fullPath);
            // Hash path + mtime for quick staleness check
            hash.update(`${fullPath}:${stats.mtimeMs}\n`);
          }
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walkDir(repoPath);
  return hash.digest('hex').slice(0, 16);
}

// =============================================================================
// Validation Stage
// =============================================================================

interface ValidationResult {
  tool: string;
  status: 'pass' | 'fail' | 'skipped';
  issues: Array<{
    file: string;
    line?: number;
    message: string;
  }>;
}

/**
 * Run ruff linter on Python files
 */
function runRuff(repoPath: string): ValidationResult {
  try {
    execSync('ruff check . --output-format=json', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { tool: 'ruff', status: 'pass', issues: [] };
  } catch (error: unknown) {
    // Ruff exits non-zero when there are issues
    const execError = error as { stdout?: string; stderr?: string };
    try {
      const stdout = execError.stdout || '';
      const issues = JSON.parse(stdout);
      return {
        tool: 'ruff',
        status: 'fail',
        issues: issues.map((i: { filename: string; location?: { row: number }; message: string }) => ({
          file: i.filename,
          line: i.location?.row,
          message: i.message,
        })),
      };
    } catch {
      return { tool: 'ruff', status: 'skipped', issues: [] };
    }
  }
}

/**
 * Run ruff format check
 */
function runRuffFormat(repoPath: string): ValidationResult {
  try {
    execSync('ruff format --check .', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { tool: 'ruff format', status: 'pass', issues: [] };
  } catch (error: unknown) {
    const execError = error as { stdout?: string };
    const stdout = execError.stdout || '';
    const files = stdout.split('\n').filter((l: string) => l.startsWith('Would reformat'));
    return {
      tool: 'ruff format',
      status: 'fail',
      issues: files.map((f: string) => ({
        file: f.replace('Would reformat ', ''),
        message: 'needs formatting',
      })),
    };
  }
}

/**
 * Run eslint on TypeScript/JavaScript files
 */
function runEslint(repoPath: string): ValidationResult {
  try {
    execSync('npx eslint . --format=json', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { tool: 'eslint', status: 'pass', issues: [] };
  } catch (error: unknown) {
    const execError = error as { stdout?: string };
    try {
      const stdout = execError.stdout || '';
      const results = JSON.parse(stdout);
      const issues: ValidationResult['issues'] = [];
      for (const result of results) {
        for (const msg of result.messages || []) {
          issues.push({
            file: result.filePath,
            line: msg.line,
            message: msg.message,
          });
        }
      }
      return { tool: 'eslint', status: issues.length > 0 ? 'fail' : 'pass', issues };
    } catch {
      return { tool: 'eslint', status: 'skipped', issues: [] };
    }
  }
}

/**
 * Run mypy type checker
 */
function runMypy(repoPath: string): ValidationResult {
  try {
    execSync('mypy . --no-error-summary', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { tool: 'mypy', status: 'pass', issues: [] };
  } catch (error: unknown) {
    const execError = error as { stdout?: string };
    const stdout = execError.stdout || '';
    const lines = stdout.split('\n').filter((l: string) => l.includes(': error:'));
    const issues = lines.map((l: string) => {
      const match = l.match(/^(.+):(\d+): error: (.+)$/);
      if (match) {
        return { file: match[1], line: parseInt(match[2]), message: match[3] };
      }
      return { file: '', message: l };
    });
    return { tool: 'mypy', status: 'fail', issues };
  }
}

/**
 * Run tsc type checker
 */
function runTsc(repoPath: string): ValidationResult {
  try {
    execSync('npx tsc --noEmit', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { tool: 'tsc', status: 'pass', issues: [] };
  } catch (error: unknown) {
    const execError = error as { stdout?: string };
    const stdout = execError.stdout || '';
    const lines = stdout.split('\n').filter((l: string) => l.includes(': error TS'));
    const issues = lines.map((l: string) => {
      const match = l.match(/^(.+)\((\d+),\d+\): error TS\d+: (.+)$/);
      if (match) {
        return { file: match[1], line: parseInt(match[2]), message: match[3] };
      }
      return { file: '', message: l };
    });
    return { tool: 'tsc', status: 'fail', issues };
  }
}

/**
 * Run all validators for detected languages
 */
function runValidation(repoPath: string, languages: string[], skipValidate: boolean): ValidationReport {
  if (skipValidate) {
    return {
      linting: { status: 'skipped', tool: 'skipped', issues: [] },
      formatting: { status: 'skipped', tool: 'skipped', issues: [] },
      types: { status: 'skipped', tool: 'skipped', issues: [] },
    };
  }

  const report: ValidationReport = {
    linting: { status: 'skipped', tool: 'none', issues: [] },
    formatting: { status: 'skipped', tool: 'none', issues: [] },
    types: { status: 'skipped', tool: 'none', issues: [] },
  };

  // Python validation
  if (languages.includes('python')) {
    const ruffResult = runRuff(repoPath);
    if (ruffResult.status !== 'skipped') {
      report.linting = ruffResult;
    }

    const formatResult = runRuffFormat(repoPath);
    if (formatResult.status !== 'skipped') {
      report.formatting = formatResult;
    }

    const mypyResult = runMypy(repoPath);
    if (mypyResult.status !== 'skipped') {
      report.types = mypyResult;
    }
  }

  // TypeScript/JavaScript validation
  if (languages.includes('typescript') || languages.includes('javascript')) {
    const eslintResult = runEslint(repoPath);
    if (eslintResult.status !== 'skipped' && report.linting.status === 'skipped') {
      report.linting = eslintResult;
    }

    const tscResult = runTsc(repoPath);
    if (tscResult.status !== 'skipped' && report.types.status === 'skipped') {
      report.types = tscResult;
    }
  }

  return report;
}

// =============================================================================
// Sync Command
// =============================================================================

async function runSync(args: string[]): Promise<void> {
  // Parse options
  let repoPath = '.';
  let languages: string[] | undefined;
  let skipValidate = false;
  let verbose = false;
  let ifStale = false;
  let ci = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--languages' && args[i + 1]) {
      languages = args[++i].split(',').map(l => l.trim());
    } else if (args[i] === '--skip-validate') {
      skipValidate = true;
    } else if (args[i] === '--if-stale') {
      ifStale = true;
    } else if (args[i] === '--ci') {
      ci = true;
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    } else if (!args[i].startsWith('-')) {
      repoPath = args[i];
    }
  }

  // Resolve to absolute path
  repoPath = path.resolve(repoPath);

  // Validate git repo
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    logError('Not a git repository (or any of the parent directories)');
    process.exit(1);
  }

  const claudeDir = path.join(repoPath, '.claude');
  const codebaseJsonPath = path.join(claudeDir, 'codebase.json');
  const checksumPath = path.join(claudeDir, '.agentifind-checksum');

  // Check staleness if --if-stale
  if (ifStale && fs.existsSync(codebaseJsonPath) && fs.existsSync(checksumPath)) {
    const existingChecksum = fs.readFileSync(checksumPath, 'utf-8').trim();

    // Detect languages first to compute checksum
    const tempAnalyzer = new StructureAnalyzer(repoPath, languages, false);
    const detectedLanguages = tempAnalyzer.getLanguages();
    const currentChecksum = computeSourceChecksum(repoPath, detectedLanguages);

    if (existingChecksum === currentChecksum) {
      log('Index is up to date, skipping sync.', 'dim');
      process.exit(0);
    }
  }

  // Ensure .claude directory exists
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  log('');
  log('Agentifind Sync', 'bright');
  log(`Repository: ${repoPath}`, 'dim');

  // Detect if this is a Terraform/IaC repo
  const isTerraformRepo = hasTerraformFiles(repoPath);

  if (isTerraformRepo) {
    log(`Repo type: Terraform/IaC`, 'dim');
    await runTerraformSync(repoPath, verbose, claudeDir, codebaseJsonPath, checksumPath);
    return;
  }

  if (languages) {
    log(`Languages: ${languages.join(', ')}`, 'dim');
  }
  log('');

  const totalSteps = skipValidate ? '3' : '4';
  let currentStep = 1;

  try {
    // Phase 1: Structure Analysis (LSP first, tree-sitter fallback)
    logStep(String(currentStep++), totalSteps, 'Extracting code structure...');

    // First detect languages using tree-sitter analyzer
    const structureAnalyzer = new StructureAnalyzer(repoPath, languages, verbose);
    const detectedLanguages = structureAnalyzer.getLanguages();

    if (verbose) {
      log(`  Detected languages: ${detectedLanguages.join(', ')}`, 'dim');
    }

    // Try LSP extraction first, fall back to tree-sitter
    let structureIndex: StructureIndex | null = null;
    let extractionMethod = 'tree-sitter';

    for (const lang of detectedLanguages) {
      if (lang === 'python' || lang === 'typescript') {
        if (verbose) {
          log(`  Trying LSP extraction for ${lang}...`, 'dim');
        }
        const lspResult = await extractWithLSP(repoPath, lang);
        if (lspResult) {
          if (verbose) {
            log(`  LSP extraction successful for ${lang}`, 'dim');
          }
          extractionMethod = 'LSP';
          // Merge with existing or use as base
          if (!structureIndex) {
            structureIndex = lspResult;
          } else {
            // Merge LSP results
            Object.assign(structureIndex.files, lspResult.files);
            Object.assign(structureIndex.symbols, lspResult.symbols);
            Object.assign(structureIndex.references, lspResult.references);
            Object.assign(structureIndex.modules, lspResult.modules);
          }
        } else if (verbose) {
          log(`  LSP not available for ${lang}, will use tree-sitter`, 'dim');
        }
      }
    }

    // Fall back to tree-sitter if LSP didn't work
    if (!structureIndex) {
      if (verbose) {
        log(`  Using tree-sitter extraction`, 'dim');
      }
      structureIndex = await structureAnalyzer.analyze();
    }

    logSuccess(`Extracted ${formatNumber(Object.keys(structureIndex.symbols).length)} symbols (${extractionMethod})`);

    // Phase 2: Validation (optional)
    let validation: ValidationReport | undefined;
    if (!skipValidate) {
      logStep(String(currentStep++), totalSteps, 'Running validators...');
      validation = runValidation(repoPath, detectedLanguages, false);

      const lintStatus = validation.linting.status;
      const formatStatus = validation.formatting.status;
      const typeStatus = validation.types.status;

      const issues: string[] = [];
      if (lintStatus === 'fail') issues.push(`linting (${validation.linting.issues.length} issues)`);
      if (formatStatus === 'fail') issues.push(`formatting (${validation.formatting.issues.length} issues)`);
      if (typeStatus === 'fail') issues.push(`types (${validation.types.issues.length} issues)`);

      if (issues.length === 0) {
        logSuccess('All validations passed');
      } else {
        logWarning(`Validation issues: ${issues.join(', ')}`);
      }
    }

    // Phase 3: Detect Analysis Gaps (Dynamic Patterns)
    logStep(String(currentStep++), totalSteps, 'Detecting analysis gaps...');
    const analysisGaps = detectAnalysisGaps(structureIndex);
    const gapsSummary = summarizeGaps(analysisGaps);
    if (analysisGaps.uncalled_exports.length > 0 ||
        analysisGaps.unused_imports.length > 0 ||
        analysisGaps.orphan_modules.length > 0) {
      logWarning(gapsSummary);
    } else {
      logSuccess(gapsSummary);
    }

    // Phase 4: Output
    logStep(String(currentStep), totalSteps, 'Writing codebase.json...');

    // Build the simplified codebase index
    const codebaseIndex: CodebaseIndex = {
      generated: new Date().toISOString(),
      commit: getGitCommit(repoPath) || 'unknown',
      stats: {
        files: Object.keys(structureIndex.files).length,
        modules: Object.keys(structureIndex.modules).length,
        functions: Object.values(structureIndex.symbols).filter(s => s.kind === 'function').length,
        classes: Object.values(structureIndex.symbols).filter(s => s.kind === 'class').length,
      },
      modules: buildModulesOutput(structureIndex),
      call_graph: buildCallGraph(structureIndex),
      import_graph: buildImportGraph(structureIndex),
      analysis_gaps: analysisGaps,
    };

    if (validation) {
      codebaseIndex.validation = validation;
    }

    // Write codebase.json
    fs.writeFileSync(codebaseJsonPath, JSON.stringify(codebaseIndex, null, 2));

    // Write checksum for staleness detection
    const checksum = computeSourceChecksum(repoPath, detectedLanguages);
    fs.writeFileSync(checksumPath, checksum);

    const jsonSize = fs.statSync(codebaseJsonPath).size;
    logSuccess(`Generated codebase.json (${formatBytes(jsonSize)})`);

    // Summary
    log('');
    log('Sync complete!', 'green');
    log(`Output: ${colors.cyan}${codebaseJsonPath}${colors.reset}`);
    log('');
    log(`Stats: ${formatNumber(codebaseIndex.stats.files)} files, ${formatNumber(codebaseIndex.stats.functions)} functions, ${formatNumber(codebaseIndex.stats.classes)} classes`);
    log('');
    log('Next: Run /agentifind skill to synthesize CODEBASE.md', 'dim');
    log('');

    // CI mode: exit non-zero if validation failed
    if (ci && validation) {
      if (validation.linting.status === 'fail' ||
          validation.formatting.status === 'fail' ||
          validation.types.status === 'fail') {
        process.exit(1);
      }
    }

  } catch (error) {
    logError(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    if (verbose && error instanceof Error) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// =============================================================================
// Output Building Helpers
// =============================================================================

function buildModulesOutput(index: StructureIndex): Record<string, ModuleInfo> {
  const modules: Record<string, ModuleInfo> = {};

  for (const [filePath, fileInfo] of Object.entries(index.files)) {
    const classes: Record<string, ClassInfo> = {};
    const functions: Record<string, FunctionInfo> = {};
    const imports: string[] = [];
    const exports: string[] = [];

    // Collect imports
    for (const imp of fileInfo.imports) {
      imports.push(imp.source);
    }

    // Collect symbols
    for (const symbolId of fileInfo.symbols) {
      const symbol = index.symbols[symbolId];
      if (!symbol) continue;

      if (symbol.exported) {
        exports.push(symbol.name);
      }

      if (symbol.kind === 'class') {
        const methods: string[] = [];
        // Find methods belonging to this class
        for (const [sid, s] of Object.entries(index.symbols)) {
          if (s.kind === 'method' && s.file === filePath && sid.includes(symbol.name)) {
            methods.push(s.name);
          }
        }
        classes[symbol.name] = {
          methods,
          inherits: [], // TODO: extract inheritance
          line: symbol.line,
        };
      } else if (symbol.kind === 'function') {
        // Find what this function calls
        const calls: string[] = [];
        const refs = index.references[symbolId] || [];
        for (const ref of refs) {
          if (ref.kind === 'call') {
            // Extract just the function name from symbolId
            const parts = ref.symbolId.split(':');
            calls.push(parts[parts.length - 1] || ref.symbolId);
          }
        }

        functions[symbol.name] = {
          calls,
          called_by: [], // Filled in later
          line: symbol.line,
        };
      }
    }

    modules[filePath] = { imports, exports, classes, functions };
  }

  return modules;
}

function buildCallGraph(index: StructureIndex): Record<string, string[]> {
  const callGraph: Record<string, string[]> = {};

  for (const [symbolId, refs] of Object.entries(index.references)) {
    const symbol = index.symbols[symbolId];
    if (!symbol) continue;

    const calls: string[] = [];
    for (const ref of refs) {
      if (ref.kind === 'call') {
        const targetSymbol = index.symbols[ref.symbolId];
        if (targetSymbol) {
          calls.push(targetSymbol.name);
        }
      }
    }

    if (calls.length > 0) {
      callGraph[symbol.name] = [...new Set(calls)];
    }
  }

  return callGraph;
}

function buildImportGraph(index: StructureIndex): Record<string, string[]> {
  const importGraph: Record<string, string[]> = {};

  for (const [filePath, fileInfo] of Object.entries(index.files)) {
    const imports: string[] = [];
    for (const imp of fileInfo.imports) {
      // Convert module path to file path if possible
      imports.push(imp.source);
    }
    if (imports.length > 0) {
      importGraph[filePath] = imports;
    }
  }

  return importGraph;
}

// =============================================================================
// Terraform Sync Command
// =============================================================================

async function runTerraformSync(
  repoPath: string,
  verbose: boolean,
  claudeDir: string,
  codebaseJsonPath: string,
  checksumPath: string
): Promise<void> {
  log('');

  const totalSteps = '3';
  let currentStep = 1;

  try {
    // Phase 1: Parse Terraform files
    logStep(String(currentStep++), totalSteps, 'Parsing Terraform configuration...');

    const { results: parseResults, method } = await parseTerraformDirectoryWithLSP(repoPath, { verbose });
    if (verbose) {
      log(`  Extraction method: ${method === 'lsp' ? 'terraform-ls (LSP)' : 'regex (fallback)'}`, 'dim');
    }

    // Aggregate results
    const allResources: InfraResource[] = [];
    const allModules: InfraModule[] = [];
    const allVariables: InfraVariable[] = [];
    const allOutputs: InfraOutput[] = [];
    const providers = new Set<string>();

    for (const result of parseResults) {
      // Convert to relative paths
      const relativeFile = path.relative(repoPath, result.file);

      for (const resource of result.resources) {
        providers.add(resource.provider);
        allResources.push({
          type: resource.type,
          name: resource.name,
          provider: resource.provider,
          file: relativeFile,
          line: resource.line,
          dependencies: resource.dependencies,
          references: resource.references,
        });
      }

      for (const module of result.modules) {
        allModules.push({
          name: module.name,
          source: module.source,
          file: relativeFile,
          line: module.line,
          inputs: module.variables,
        });
      }

      for (const variable of result.variables) {
        allVariables.push({
          name: variable.name,
          type: variable.type,
          default: variable.default,
          description: variable.description,
          file: relativeFile,
          line: variable.line,
          used_by: [], // Computed below
        });
      }

      for (const output of result.outputs) {
        allOutputs.push({
          name: output.name,
          value: output.value,
          description: output.description,
          file: relativeFile,
          line: output.line,
          references: output.references,
        });
      }
    }

    logSuccess(`Parsed ${allResources.length} resources, ${allModules.length} modules`);

    // Phase 2: Build dependency graph
    logStep(String(currentStep++), totalSteps, 'Building dependency graph...');

    const dependencyGraph: Record<string, string[]> = {};

    for (const resource of allResources) {
      const resourceId = `${resource.type}.${resource.name}`;
      const deps: string[] = [...resource.dependencies];

      // Extract dependencies from references
      for (const ref of resource.references) {
        // Match patterns like aws_instance.web, module.vpc, var.name
        if (ref.includes('.') && !ref.startsWith('var.') && !ref.startsWith('local.')) {
          deps.push(ref.split('.').slice(0, 2).join('.'));
        }
      }

      if (deps.length > 0) {
        dependencyGraph[resourceId] = [...new Set(deps)];
      }
    }

    // Compute variable usage
    for (const variable of allVariables) {
      const varRef = `var.${variable.name}`;
      for (const resource of allResources) {
        if (resource.references.some(r => r.includes(varRef))) {
          variable.used_by.push(`${resource.type}.${resource.name}`);
        }
      }
      for (const module of allModules) {
        if (Object.values(module.inputs).some(v => v.includes(varRef))) {
          variable.used_by.push(`module.${module.name}`);
        }
      }
    }

    // Compute blast radius
    const blastRadius: BlastRadius[] = [];
    const reverseGraph: Record<string, string[]> = {};

    // Build reverse dependency graph
    for (const [target, deps] of Object.entries(dependencyGraph)) {
      for (const dep of deps) {
        if (!reverseGraph[dep]) {
          reverseGraph[dep] = [];
        }
        reverseGraph[dep].push(target);
      }
    }

    // Calculate blast radius for resources with dependents
    for (const [resourceId, dependents] of Object.entries(reverseGraph)) {
      if (dependents.length > 0) {
        const affected = new Set<string>();
        const queue = [...dependents];

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (!affected.has(current)) {
            affected.add(current);
            if (reverseGraph[current]) {
              queue.push(...reverseGraph[current]);
            }
          }
        }

        const count = affected.size;
        blastRadius.push({
          target: resourceId,
          affected_resources: [...affected],
          severity: count <= 5 ? 'low' : count <= 20 ? 'medium' : 'high',
        });
      }
    }

    // Sort by severity
    blastRadius.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.severity] - order[b.severity];
    });

    logSuccess(`Built dependency graph with ${Object.keys(dependencyGraph).length} edges`);

    // Phase 3: Write infrastructure.json
    logStep(String(currentStep), totalSteps, 'Writing codebase.json...');

    // Group resources by type
    const resourcesByType: Record<string, InfraResource[]> = {};
    for (const resource of allResources) {
      if (!resourcesByType[resource.type]) {
        resourcesByType[resource.type] = [];
      }
      resourcesByType[resource.type].push(resource);
    }

    const infraIndex: InfrastructureIndex = {
      generated: new Date().toISOString(),
      commit: getGitCommit(repoPath) || 'unknown',
      repo_type: 'terraform',
      extraction_method: method,
      stats: {
        files: parseResults.length,
        resources: allResources.length,
        modules: allModules.length,
        variables: allVariables.length,
        outputs: allOutputs.length,
        providers: [...providers],
      },
      resources: resourcesByType,
      modules: allModules,
      variables: allVariables,
      outputs: allOutputs,
      dependency_graph: dependencyGraph,
      blast_radius: blastRadius.slice(0, 20), // Top 20 by severity
    };

    // Write codebase.json
    fs.writeFileSync(codebaseJsonPath, JSON.stringify(infraIndex, null, 2));

    // Write checksum for staleness detection
    const checksum = computeTerraformChecksum(repoPath);
    fs.writeFileSync(checksumPath, checksum);

    const jsonSize = fs.statSync(codebaseJsonPath).size;
    logSuccess(`Generated codebase.json (${formatBytes(jsonSize)})`);

    // Summary
    log('');
    log('Sync complete!', 'green');
    log(`Output: ${colors.cyan}${codebaseJsonPath}${colors.reset}`);
    log('');
    log(`Stats: ${formatNumber(parseResults.length)} files, ${formatNumber(allResources.length)} resources, ${formatNumber(allModules.length)} modules`);
    log(`Providers: ${[...providers].join(', ')}`);
    if (blastRadius.length > 0) {
      const highRisk = blastRadius.filter(b => b.severity === 'high').length;
      if (highRisk > 0) {
        logWarning(`${highRisk} high-risk resources detected (see blast_radius)`);
      }
    }
    log('');
    log('Next: Run /agentifind skill to synthesize CODEBASE.md', 'dim');
    log('');

  } catch (error) {
    logError(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    if (verbose && error instanceof Error) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

/**
 * Compute checksum for Terraform files
 */
function computeTerraformChecksum(repoPath: string): string {
  const hash = crypto.createHash('sha256');

  function walkDir(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip hidden dirs and .terraform
        if (entry.name.startsWith('.') || entry.name === '.terraform') {
          continue;
        }

        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          if (entry.name.endsWith('.tf') || entry.name.endsWith('.tfvars')) {
            const stats = fs.statSync(fullPath);
            hash.update(`${fullPath}:${stats.mtimeMs}\n`);
          }
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walkDir(repoPath);
  return hash.digest('hex').slice(0, 16);
}

// =============================================================================
// Status Command
// =============================================================================

async function runStatus(args: string[]): Promise<void> {
  let repoPath = '.';

  for (const arg of args) {
    if (!arg.startsWith('-')) {
      repoPath = arg;
    }
  }

  repoPath = path.resolve(repoPath);

  const claudeDir = path.join(repoPath, '.claude');
  const codebaseJsonPath = path.join(claudeDir, 'codebase.json');
  const checksumPath = path.join(claudeDir, '.agentifind-checksum');

  log('');
  log('Agentifind Status', 'bright');
  log('');

  if (!fs.existsSync(codebaseJsonPath)) {
    log('Status: NOT INITIALIZED', 'yellow');
    log('');
    log('Run "agentifind sync" to initialize.', 'dim');
    process.exit(1);
  }

  // Read existing index
  const codebaseIndex: CodebaseIndex = JSON.parse(fs.readFileSync(codebaseJsonPath, 'utf-8'));

  log(`Guide: ${codebaseJsonPath}`);
  log(`Generated: ${codebaseIndex.generated}`);
  log(`Commit: ${codebaseIndex.commit}`);
  log('');

  // Check staleness
  if (fs.existsSync(checksumPath)) {
    const existingChecksum = fs.readFileSync(checksumPath, 'utf-8').trim();

    // Detect languages to compute current checksum
    const tempAnalyzer = new StructureAnalyzer(repoPath, undefined, false);
    const detectedLanguages = tempAnalyzer.getLanguages();
    const currentChecksum = computeSourceChecksum(repoPath, detectedLanguages);

    if (existingChecksum === currentChecksum) {
      log('Status: UP TO DATE', 'green');
    } else {
      // Count changed files
      const changedFiles = getChangedFilesSince(repoPath, codebaseIndex.generated);
      log(`Status: STALE`, 'yellow');
      log(`Files changed since: ${changedFiles.length}`);
      log('');
      log('Run "agentifind sync" to update.', 'dim');
    }
  } else {
    log('Status: UNKNOWN (no checksum)', 'yellow');
    log('');
    log('Run "agentifind sync" to regenerate.', 'dim');
  }

  log('');
}

// =============================================================================
// Help
// =============================================================================

function showHelp(): void {
  console.log(`
${colors.bright}Agentifind${colors.reset} - Codebase Intelligence for AI Agents

${colors.bright}Usage:${colors.reset} agentifind <command> [options]

${colors.bright}Commands:${colors.reset}
  sync [dir]           Extract code structure and validate
  status [dir]         Check if codebase.json is stale

${colors.bright}Sync Options:${colors.reset}
  --languages <list>   Comma-separated list of languages to analyze
  --skip-validate      Skip validation stage (faster)
  --if-stale           Only sync if index is stale
  --ci                 CI mode (exit non-zero on validation failures)
  --verbose, -v        Enable verbose output

${colors.bright}Output:${colors.reset}
  .claude/codebase.json     Structured code data
  .claude/.agentifind-checksum  Staleness detection

${colors.bright}Examples:${colors.reset}
  agentifind sync
  agentifind sync --skip-validate
  agentifind sync --if-stale
  agentifind status

${colors.bright}Skill:${colors.reset}
  After sync, run /agentifind skill to synthesize CODEBASE.md

For more information, see the documentation.
`);
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // Handle help flags
  if (!command || command === '--help' || command === '-h') {
    showHelp();
    process.exit(0);
  }

  // Handle version flag
  if (command === '--version' || command === '-V') {
    console.log('agentifind version 2.0.0');
    process.exit(0);
  }

  switch (command) {
    case 'sync':
      await runSync(args.slice(1));
      break;

    case 'status':
      await runStatus(args.slice(1));
      break;

    // Legacy command support
    case 'init':
      log('Note: "init" is deprecated, use "sync" instead', 'yellow');
      await runSync(args.slice(1));
      break;

    default:
      logError(`Unknown command: ${command}`);
      console.error('Run "agentifind --help" for usage information.');
      process.exit(1);
  }
}

main().catch((error) => {
  logError(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error) {
    console.error(error.stack);
  }
  process.exit(1);
});
