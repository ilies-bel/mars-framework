/**
 * Anomaly Detector
 *
 * Detects gaps in the call graph that may indicate dynamic patterns
 * the static analysis cannot fully trace. This is done WITHOUT hardcoded
 * pattern matching - purely by analyzing the graph structure.
 *
 * Key principle: If something is exported but never called, or imported
 * but never used, it's likely being invoked dynamically (plugins, signals,
 * decorators, event handlers, etc.)
 */

import type {
  StructureIndex,
  AnalysisGaps,
  AnalysisGap,
  SymbolInfo,
  FilePath,
} from '../types.js';

/**
 * Files that are typically entry points and shouldn't be flagged as orphans
 */
const KNOWN_ENTRY_PATTERNS = [
  /^__main__\.py$/,
  /^main\.(py|ts|js)$/,
  /^index\.(ts|tsx|js|jsx)$/,
  /^cli\.(py|ts|js)$/,
  /^app\.(py|ts|js)$/,
  /^server\.(py|ts|js)$/,
  /^setup\.py$/,
  /^conftest\.py$/,
  /\.config\.(ts|js)$/,
  /\.test\.(ts|tsx|js|jsx)$/,
  /\.spec\.(ts|tsx|js|jsx)$/,
  /_test\.py$/,
  /test_.*\.py$/,
];

/**
 * Symbol names that are typically framework-invoked (not user code)
 */
const FRAMEWORK_INVOKED_PATTERNS = [
  /^__init__$/,
  /^__main__$/,
  /^__new__$/,
  /^__call__$/,
  /^__str__$/,
  /^__repr__$/,
  /^__eq__$/,
  /^__hash__$/,
  /^__iter__$/,
  /^__next__$/,
  /^__enter__$/,
  /^__exit__$/,
  /^__getattr__$/,
  /^__setattr__$/,
  /^__getitem__$/,
  /^__setitem__$/,
  /^setUp$/,
  /^tearDown$/,
  /^setUpClass$/,
  /^tearDownClass$/,
];

/**
 * Detect analysis gaps in the codebase structure
 */
export function detectAnalysisGaps(index: StructureIndex): AnalysisGaps {
  return {
    uncalled_exports: detectUncalledExports(index),
    unused_imports: detectUnusedImports(index),
    orphan_modules: detectOrphanModules(index),
  };
}

/**
 * Find exported functions/classes that have no callers in the codebase
 * These are likely:
 * - Entry points (CLI, main, API handlers)
 * - Dynamically invoked (plugins, signals, decorators)
 * - Framework callbacks (test functions, hooks)
 */
function detectUncalledExports(index: StructureIndex): AnalysisGap[] {
  const gaps: AnalysisGap[] = [];

  // Build a set of all symbol IDs that are referenced (called)
  const calledSymbols = new Set<string>();
  for (const refs of Object.values(index.references)) {
    for (const ref of refs) {
      if (ref.kind === 'call') {
        calledSymbols.add(ref.symbolId);
        // Also add the short name for fuzzy matching
        const shortName = ref.symbolId.split(':').pop() || ref.symbolId;
        calledSymbols.add(shortName);
      }
    }
  }

  // Also collect all symbol names that appear in call references
  const calledNames = new Set<string>();
  for (const symbol of Object.values(index.symbols)) {
    if (calledSymbols.has(symbol.id) || calledSymbols.has(symbol.name)) {
      calledNames.add(symbol.name);
    }
  }

  // Find exported symbols with no callers
  for (const [symbolId, symbol] of Object.entries(index.symbols)) {
    // Only check exported functions and classes
    if (!symbol.exported) continue;
    if (symbol.kind !== 'function' && symbol.kind !== 'class') continue;

    // Skip framework-invoked patterns
    if (isFrameworkInvoked(symbol.name)) continue;

    // Check if this symbol is ever called
    const isCalled =
      calledSymbols.has(symbolId) ||
      calledSymbols.has(symbol.name) ||
      calledNames.has(symbol.name);

    if (!isCalled) {
      gaps.push({
        name: symbol.name,
        file: symbol.file,
        line: symbol.line,
        reason: `Exported ${symbol.kind} with no detected callers`,
      });
    }
  }

  // Sort by file for readability
  gaps.sort((a, b) => a.file.localeCompare(b.file));

  return gaps;
}

/**
 * Find imports that are never referenced in code
 * These are likely:
 * - Side-effect imports (import 'polyfill')
 * - Re-exports (export { foo } from 'bar')
 * - Type-only imports in JS
 * - Dynamically accessed modules
 */
function detectUnusedImports(index: StructureIndex): AnalysisGap[] {
  const gaps: AnalysisGap[] = [];

  for (const [filePath, fileInfo] of Object.entries(index.files)) {
    // Build set of referenced names in this file
    const referencedNames = new Set<string>();

    // Get all references made FROM this file
    const parseResult = Object.values(index.references)
      .flat()
      .filter(ref => ref.file === filePath);

    for (const ref of parseResult) {
      // Extract the name being referenced
      const refName = ref.symbolId.split('.')[0]; // Get first part (module or symbol)
      referencedNames.add(refName);
      referencedNames.add(ref.symbolId); // Full reference
    }

    // Check each import
    for (const imp of fileInfo.imports) {
      // Skip wildcard imports - they're hard to track
      if (imp.isWildcard) continue;

      // Check each imported symbol
      for (const sym of imp.symbols) {
        const name = sym.alias || sym.name;

        // Skip if it's a namespace import (used as prefix)
        if (name === '*') continue;

        // Check if this import is ever used
        const isUsed =
          referencedNames.has(name) ||
          referencedNames.has(sym.name) ||
          // Check for dotted references like module.func
          Array.from(referencedNames).some(ref => ref.startsWith(`${name}.`));

        if (!isUsed) {
          gaps.push({
            name: sym.alias ? `${sym.name} as ${sym.alias}` : sym.name,
            file: filePath,
            line: imp.line,
            reason: `Import from '${imp.source}' not referenced in code`,
          });
        }
      }

      // Check module-level imports (import X or import X as Y)
      if (imp.moduleAlias) {
        const alias = imp.moduleAlias;
        const isUsed =
          referencedNames.has(alias) ||
          Array.from(referencedNames).some(ref => ref.startsWith(`${alias}.`));

        if (!isUsed) {
          gaps.push({
            name: alias,
            file: filePath,
            line: imp.line,
            reason: `Module import '${imp.source}' never referenced`,
          });
        }
      }
    }
  }

  // Sort by file for readability
  gaps.sort((a, b) => a.file.localeCompare(b.file));

  return gaps;
}

/**
 * Find files that are never imported by any other file
 * These are likely:
 * - Entry points (main, CLI, scripts)
 * - Test files
 * - Config files
 * - Dynamically loaded modules (plugins)
 */
function detectOrphanModules(index: StructureIndex): AnalysisGap[] {
  const gaps: AnalysisGap[] = [];

  // Build set of all imported module paths
  const importedModules = new Set<string>();

  for (const fileInfo of Object.values(index.files)) {
    for (const imp of fileInfo.imports) {
      // Add the import source
      importedModules.add(imp.source);

      // Also add normalized versions for matching
      // Convert dots to slashes for path matching
      const asPath = imp.source.replace(/\./g, '/');
      importedModules.add(asPath);

      // Add with common extensions
      importedModules.add(`${asPath}.py`);
      importedModules.add(`${asPath}.ts`);
      importedModules.add(`${asPath}.tsx`);
      importedModules.add(`${asPath}.js`);
      importedModules.add(`${asPath}.jsx`);
    }
  }

  // Check each file
  for (const filePath of Object.keys(index.files)) {
    // Skip known entry point patterns
    if (isKnownEntryPoint(filePath)) continue;

    // Check if this file is ever imported
    const isImported = isFileImported(filePath, importedModules);

    if (!isImported) {
      gaps.push({
        name: filePath,
        file: filePath,
        reason: 'File never imported by other modules',
      });
    }
  }

  // Sort by file for readability
  gaps.sort((a, b) => a.file.localeCompare(b.file));

  return gaps;
}

/**
 * Check if a symbol name matches framework-invoked patterns
 */
function isFrameworkInvoked(name: string): boolean {
  return FRAMEWORK_INVOKED_PATTERNS.some(pattern => pattern.test(name));
}

/**
 * Check if a file path matches known entry point patterns
 */
function isKnownEntryPoint(filePath: FilePath): boolean {
  const basename = filePath.split('/').pop() || filePath;
  return KNOWN_ENTRY_PATTERNS.some(pattern => pattern.test(basename));
}

/**
 * Check if a file is imported by any module
 */
function isFileImported(filePath: FilePath, importedModules: Set<string>): boolean {
  // Normalize the file path for comparison
  const normalized = filePath.replace(/\\/g, '/');

  // Direct match
  if (importedModules.has(normalized)) return true;

  // Check without extension (.ts, .tsx, .js, .jsx, .py)
  const withoutExt = normalized.replace(/\.(py|ts|tsx|js|jsx|mjs|cjs)$/, '');
  if (importedModules.has(withoutExt)) return true;

  // ESM-style imports use .js for TypeScript files, so also check that mapping
  // e.g., "src/types.ts" should match import "./types.js"
  const asJsImport = withoutExt + '.js';
  if (importedModules.has(asJsImport)) return true;

  // Check as module path (slashes to dots)
  const asModule = withoutExt.replace(/\//g, '.');
  if (importedModules.has(asModule)) return true;

  // Check if any import source is a substring match
  // This handles cases like "app.services.foo" matching "app/services/foo.py"
  for (const imported of importedModules) {
    // Normalize the import path (handle ./ prefix, .js extension)
    const normalizedImport = imported
      .replace(/^\.\//, '')
      .replace(/\.(js|ts|tsx|jsx|py)$/, '');

    // Check if file path ends with the import path
    if (withoutExt.endsWith(normalizedImport)) {
      return true;
    }

    // Check if import ends with file path
    if (normalizedImport.endsWith(withoutExt.split('/').pop() || '')) {
      return true;
    }

    // Legacy substring matching
    if (normalized.includes(imported) || imported.includes(withoutExt)) {
      return true;
    }
  }

  return false;
}

/**
 * Summarize analysis gaps for logging
 */
export function summarizeGaps(gaps: AnalysisGaps): string {
  const parts: string[] = [];

  if (gaps.uncalled_exports.length > 0) {
    parts.push(`${gaps.uncalled_exports.length} uncalled exports`);
  }
  if (gaps.unused_imports.length > 0) {
    parts.push(`${gaps.unused_imports.length} unused imports`);
  }
  if (gaps.orphan_modules.length > 0) {
    parts.push(`${gaps.orphan_modules.length} orphan modules`);
  }

  if (parts.length === 0) {
    return 'No analysis gaps detected - call graph appears complete';
  }

  return `Detected: ${parts.join(', ')}`;
}
