/**
 * Structure Analyzer
 *
 * Builds the dependency graph from parsed AST data and generates
 * the main index.json file along with test mappings and entry points.
 */

import * as fs from 'fs';
import * as path from 'path';
import streamJsonPkg from 'stream-json';
import streamObjectPkg from 'stream-json/streamers/StreamObject.js';
const { parser } = streamJsonPkg;
const { streamObject } = streamObjectPkg;
import type {
  ParseResult,
  StructureIndex,
  FileInfo,
  SymbolInfo,
  Reference,
  InternalModuleInfo,
  TestMapping,
  TestMap,
  EntryPoint,
  EntryPoints,
  Import,
  FilePath,
  SymbolId,
  FileRelationship,
  IndexStats,
  ParseOptions,
} from '../types.js';
import { parsePythonDirectory } from '../parsers/python.js';
import { parseTypeScriptDirectory } from '../parsers/typescript.js';

/**
 * Directories to skip when scanning for files
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'vendor',
  '__pycache__',
  '.git',
  '.venv',
  'venv',
  'env',
  '.env',
  'dist',
  'build',
  '.tox',
  '.pytest_cache',
  '.mypy_cache',
  'coverage',
  '.coverage',
]);

/**
 * Structure analyzer class for building the complete code index
 */
export class StructureAnalyzer {
  private repoRoot: string;
  private languages: string[];
  private parseResults: ParseResult[] = [];
  private verbose: boolean;
  private outputDir?: string;

  constructor(repoRoot: string, languages?: string[], verbose?: boolean) {
    this.repoRoot = path.resolve(repoRoot);
    this.languages = languages || this.detectLanguages();
    this.verbose = verbose || false;
  }

  /**
   * Detect languages by scanning file extensions in the repository
   */
  detectLanguages(): string[] {
    const detected = new Set<string>();
    this.scanForLanguages(this.repoRoot, detected);
    return Array.from(detected);
  }

  /**
   * Recursively scan directory for language files
   */
  private scanForLanguages(dirPath: string, detected: Set<string>): void {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
            this.scanForLanguages(path.join(dirPath, entry.name), detected);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          switch (ext) {
            case '.py':
              detected.add('python');
              break;
            case '.ts':
            case '.tsx':
              detected.add('typescript');
              break;
            case '.js':
            case '.jsx':
            case '.mjs':
            case '.cjs':
              detected.add('javascript');
              break;
          }
        }
      }
    } catch {
      // Silently skip directories we can't read
    }
  }

  /**
   * Parse all source files for detected languages
   *
   * @param errorLogPath - Optional path to write parse errors log
   */
  async parseAll(errorLogPath?: string): Promise<void> {
    this.parseResults = [];

    // Build parse options
    const parseOptions: ParseOptions = {
      verbose: this.verbose,
      errorLogPath,
    };

    for (const lang of this.languages) {
      if (lang === 'python') {
        const results = await parsePythonDirectory(this.repoRoot, parseOptions);
        this.parseResults.push(...results);
      } else if (lang === 'typescript' || lang === 'javascript') {
        const results = await parseTypeScriptDirectory(this.repoRoot, parseOptions);
        this.parseResults.push(...results);
      }
    }
  }

  /**
   * Analyze the repository and return the structure index
   * This is the main entry point for the simplified codebase.json output
   */
  async analyze(): Promise<StructureIndex> {
    await this.parseAll();
    const index = this.buildIndex();
    return this.convertIndexToRelativePaths(index);
  }

  /**
   * Build the structure index from parse results
   */
  buildIndex(): StructureIndex {
    const files: Record<FilePath, FileInfo> = {};
    const symbols: Record<SymbolId, SymbolInfo> = {};
    const references: Record<SymbolId, Reference[]> = {};
    const modules: Record<string, InternalModuleInfo> = {};

    // First pass: collect all symbols and files
    for (const result of this.parseResults) {
      // Build file info
      const fileSymbolIds = result.symbols.map((s) => s.id);

      files[result.file] = {
        path: result.file,
        language: result.language,
        lines: this.countLines(result.file),
        symbols: fileSymbolIds,
        imports: result.imports,
      };

      // Build symbols map
      for (const symbol of result.symbols) {
        symbols[symbol.id] = symbol;
      }

      // Detect and build module info
      const moduleDir = path.dirname(result.file);
      const relativePath = path.relative(this.repoRoot, moduleDir);

      if (!modules[relativePath]) {
        modules[relativePath] = {
          path: relativePath,
          files: [],
          exports: [],
          isPublic: this.isPublicModule(relativePath, result.language),
        };
      }

      modules[relativePath].files.push(result.file);

      // Add exported symbols to module
      for (const symbol of result.symbols) {
        if (symbol.exported) {
          modules[relativePath].exports.push(symbol.id);
        }
      }
    }

    // Second pass: build references map (inverted index: symbol -> references to it)
    // First, create a lookup for symbol names to their full IDs
    const symbolNameToIds = this.buildSymbolNameLookup(symbols);

    for (const result of this.parseResults) {
      for (const ref of result.references) {
        // Try to resolve the reference to actual symbol(s)
        const resolvedSymbolIds = this.resolveReference(
          ref,
          result.imports,
          symbolNameToIds,
          result.file
        );

        for (const symbolId of resolvedSymbolIds) {
          // Use hasOwnProperty to avoid collision with built-in properties like 'constructor'
          if (!Object.prototype.hasOwnProperty.call(references, symbolId)) {
            references[symbolId] = [];
          }
          references[symbolId].push({
            ...ref,
            symbolId, // Update to resolved symbol ID
          });
        }
      }
    }

    return {
      version: '1.0',
      generated: new Date().toISOString(),
      repoRoot: this.repoRoot,
      languages: this.languages,
      files,
      symbols,
      references,
      modules,
    };
  }

  /**
   * Build a lookup table from symbol names to their full IDs
   */
  private buildSymbolNameLookup(
    symbols: Record<SymbolId, SymbolInfo>
  ): Map<string, SymbolId[]> {
    const lookup = new Map<string, SymbolId[]>();

    for (const [id, symbol] of Object.entries(symbols)) {
      const name = symbol.name;

      // Add full name
      if (!lookup.has(name)) {
        lookup.set(name, []);
      }
      lookup.get(name)!.push(id);

      // For methods (ClassName.methodName), also add just the method name
      if (name.includes('.')) {
        const shortName = name.split('.').pop()!;
        if (!lookup.has(shortName)) {
          lookup.set(shortName, []);
        }
        lookup.get(shortName)!.push(id);
      }
    }

    return lookup;
  }

  /**
   * Resolve a reference to potential symbol IDs
   */
  private resolveReference(
    ref: Reference,
    imports: Import[],
    symbolLookup: Map<string, SymbolId[]>,
    currentFile: string
  ): SymbolId[] {
    const refName = ref.symbolId;

    // Direct match in symbol lookup
    if (symbolLookup.has(refName)) {
      return symbolLookup.get(refName)!;
    }

    // Try to resolve via imports
    // For calls like module.func or obj.method (e.g., Y.func where Y is an alias)
    if (refName.includes('.')) {
      const [prefix, ...rest] = refName.split('.');
      const suffix = rest.join('.');

      // Check if prefix is a module-level alias: `import X as Y` -> Y.func resolves to X.func
      for (const imp of imports) {
        // Match module alias (import X as Y) or the base module name
        if (imp.moduleAlias === prefix || this.getImportBaseName(imp.source) === prefix) {
          // Try to resolve the symbol from this module
          const resolved = this.resolveFromModule(suffix, imp.source, symbolLookup, currentFile);
          if (resolved.length > 0) {
            return resolved;
          }
        }

        // Also check if prefix matches a per-symbol alias or imported name
        // e.g., `from X import MyClass as MC` -> MC.method
        // or `from X import credits` -> credits.deduct_credits()
        const symbolWithAlias = imp.symbols.find(
          (s) => s.alias === prefix || (s.name === prefix && !s.alias)
        );
        if (symbolWithAlias) {
          // The alias refers to the original symbol, so resolve originalName.suffix
          const qualifiedName = `${symbolWithAlias.name}.${suffix}`;
          const resolved = this.resolveFromModule(qualifiedName, imp.source, symbolLookup, currentFile);
          if (resolved.length > 0) {
            return resolved;
          }
          // Also try just the suffix with the original symbol as context
          if (symbolLookup.has(qualifiedName)) {
            return symbolLookup.get(qualifiedName)!;
          }

          // Handle submodule imports: `from app.services import credits as credit_service`
          // where `credits` is a submodule containing `deduct_credits`
          // Try resolving suffix from submodule: app.services.credits.deduct_credits
          const submodulePath = `${imp.source}.${symbolWithAlias.name}`;
          const submoduleResolved = this.resolveFromModule(suffix, submodulePath, symbolLookup, currentFile);
          if (submoduleResolved.length > 0) {
            return submoduleResolved;
          }
        }
      }
    }

    // Check if name matches any imported symbols (including per-symbol aliases)
    for (const imp of imports) {
      // Check if name matches a symbol name or alias from ImportedSymbol[]
      const matchingSymbol = imp.symbols.find(
        (s) => s.name === refName || s.alias === refName
      );
      // Also check for wildcard imports
      const isWildcard = imp.isWildcard || imp.symbols.some((s) => s.name === '*');

      if (matchingSymbol || isWildcard) {
        // If the reference used an alias, find the original name
        // Per-symbol alias: `from X import func as f` -> f resolves to X.func
        const originalName = matchingSymbol?.alias === refName
          ? matchingSymbol.name
          : refName;

        // Try to resolve from the module
        const resolved = this.resolveFromModule(originalName, imp.source, symbolLookup, currentFile);
        if (resolved.length > 0) {
          return resolved;
        }

        // Fall back to direct lookup
        if (symbolLookup.has(originalName)) {
          const candidates = symbolLookup.get(originalName)!;
          const filtered = candidates.filter((id) =>
            this.isFromImportedModule(id, imp.source, currentFile)
          );
          if (filtered.length > 0) {
            return filtered;
          }
        }
      }
    }

    // Return unresolved reference as-is (might be external or builtin)
    return [refName];
  }

  /**
   * Resolve a symbol name from a specific module path
   */
  private resolveFromModule(
    symbolName: string,
    modulePath: string,
    symbolLookup: Map<string, SymbolId[]>,
    currentFile: string
  ): SymbolId[] {
    // First try direct lookup
    if (symbolLookup.has(symbolName)) {
      const candidates = symbolLookup.get(symbolName)!;
      const filtered = candidates.filter((id) =>
        this.isFromImportedModule(id, modulePath, currentFile)
      );
      if (filtered.length > 0) {
        return filtered;
      }
    }

    // Try with module path prefix for qualified names
    const moduleBaseName = this.getImportBaseName(modulePath);
    const qualifiedName = `${moduleBaseName}.${symbolName}`;
    if (symbolLookup.has(qualifiedName)) {
      const candidates = symbolLookup.get(qualifiedName)!;
      const filtered = candidates.filter((id) =>
        this.isFromImportedModule(id, modulePath, currentFile)
      );
      if (filtered.length > 0) {
        return filtered;
      }
    }

    return [];
  }

  /**
   * Check if a symbol ID is from an imported module
   */
  private isFromImportedModule(
    symbolId: SymbolId,
    importSource: string,
    _currentFile: string
  ): boolean {
    // Extract file path from symbol ID (format: filepath:name:line)
    const symbolFile = symbolId.split(':')[0];

    // Handle relative imports (Python)
    if (importSource.startsWith('.')) {
      const relativeModule = importSource.replace(/^\.+/, '');
      const relativePath = relativeModule.replace(/\./g, path.sep);
      return symbolFile.includes(relativePath);
    }

    // Handle absolute imports
    const modulePath = importSource.replace(/\./g, path.sep);
    return symbolFile.includes(modulePath);
  }

  /**
   * Get the base name from an import source
   */
  private getImportBaseName(source: string): string {
    const parts = source.split(/[./]/);
    return parts[parts.length - 1];
  }

  /**
   * Count lines in a file
   */
  private countLines(filePath: string): number {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.split('\n').length;
    } catch {
      return 0;
    }
  }

  /**
   * Determine if a module is public based on conventions
   */
  private isPublicModule(modulePath: string, language: string): boolean {
    // Skip test directories
    if (
      modulePath.includes('test') ||
      modulePath.includes('tests') ||
      modulePath.includes('__tests__')
    ) {
      return false;
    }

    // Python: directories with __init__.py are packages
    if (language === 'python') {
      const initPath = path.join(this.repoRoot, modulePath, '__init__.py');
      if (fs.existsSync(initPath)) {
        // Check if it's internal (starts with underscore)
        return !path.basename(modulePath).startsWith('_');
      }
    }

    // Default: consider public unless clearly internal
    const baseName = path.basename(modulePath);
    return !baseName.startsWith('_') && !baseName.startsWith('.');
  }

  /**
   * Build test mapping: which tests cover which source files
   */
  buildTestMap(): TestMap {
    const mappings: TestMapping[] = [];
    const sourceFiles: FilePath[] = [];
    const testFiles: FilePath[] = [];

    // Separate source and test files
    for (const result of this.parseResults) {
      if (this.isTestFile(result.file, result.language)) {
        testFiles.push(result.file);
      } else {
        sourceFiles.push(result.file);
      }
    }

    // Build reverse import graph for transitive dependency tracking
    const reverseImportGraph = this.buildReverseImportGraph();

    // For each source file, find associated tests
    for (const sourceFile of sourceFiles) {
      const associatedTests = this.findTestsForSource(sourceFile, testFiles, reverseImportGraph);

      if (associatedTests.length > 0) {
        // Find test functions in the test files
        const testFunctions: string[] = [];

        for (const testFile of associatedTests) {
          const parseResult = this.parseResults.find((r) => r.file === testFile);
          if (parseResult) {
            for (const symbol of parseResult.symbols) {
              if (this.isTestFunction(symbol.name, parseResult.language)) {
                testFunctions.push(symbol.name);
              }
            }
          }
        }

        mappings.push({
          sourceFile,
          testFiles: associatedTests,
          testFunctions,
        });
      }
    }

    return { version: '1.0', mappings };
  }

  /**
   * Build a reverse import graph: file -> files that import it
   * This enables finding transitive importers of any file
   * Optimized to O(n) by pre-building lookup maps
   */
  private buildReverseImportGraph(): Map<FilePath, Set<FilePath>> {
    const reverseGraph = new Map<FilePath, Set<FilePath>>();

    // Pre-build lookup maps for efficient matching (O(n) instead of O(n²))
    const filesByBasename = new Map<string, FilePath[]>();
    const filesByModulePath = new Map<string, FilePath[]>();

    for (const result of this.parseResults) {
      const relativePath = path.relative(this.repoRoot, result.file);
      const basename = path.basename(result.file, path.extname(result.file));

      // Index by basename
      if (!filesByBasename.has(basename)) {
        filesByBasename.set(basename, []);
      }
      filesByBasename.get(basename)!.push(result.file);

      // Index by module-style path (e.g., "fastapi/routing" for "fastapi/routing.py")
      const modulePath = relativePath.replace(/\.[^.]+$/, '').replace(/\//g, '.');
      if (!filesByModulePath.has(modulePath)) {
        filesByModulePath.set(modulePath, []);
      }
      filesByModulePath.get(modulePath)!.push(result.file);
    }

    // Build the reverse graph using the lookup maps
    for (const result of this.parseResults) {
      for (const imp of result.imports) {
        const importedFiles = this.resolveImportSourceFast(imp.source, filesByBasename, filesByModulePath);

        for (const importedFile of importedFiles) {
          if (!reverseGraph.has(importedFile)) {
            reverseGraph.set(importedFile, new Set());
          }
          reverseGraph.get(importedFile)!.add(result.file);
        }
      }
    }

    return reverseGraph;
  }

  /**
   * Fast import source resolution using pre-built lookup maps
   */
  private resolveImportSourceFast(
    importSource: string,
    filesByBasename: Map<string, FilePath[]>,
    filesByModulePath: Map<string, FilePath[]>
  ): FilePath[] {
    // Try exact module path match first (e.g., "fastapi.routing" -> "fastapi/routing.py")
    const normalizedSource = importSource.replace(/\//g, '.');
    if (filesByModulePath.has(normalizedSource)) {
      return filesByModulePath.get(normalizedSource)!;
    }

    // Try matching last component as basename (e.g., "routing" from "fastapi.routing")
    const parts = importSource.split('.');
    const lastPart = parts[parts.length - 1];
    if (filesByBasename.has(lastPart)) {
      // Filter to files that match the import path pattern
      const candidates = filesByBasename.get(lastPart)!;
      if (parts.length === 1) {
        return candidates;
      }
      // For multi-part imports, filter by path containing the prefix
      const prefix = parts.slice(0, -1).join(path.sep);
      return candidates.filter(f => f.includes(prefix));
    }

    return [];
  }

  /**
   * Find all files that transitively import a given file
   * Uses BFS to traverse the reverse import graph up to maxDepth
   */
  private findTransitiveImporters(
    file: FilePath,
    reverseGraph: Map<FilePath, Set<FilePath>>,
    maxDepth: number = 3
  ): Set<FilePath> {
    const importers = new Set<FilePath>();
    const visited = new Set<FilePath>();
    const queue: { file: FilePath; depth: number }[] = [{ file, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (visited.has(current.file)) {
        continue;
      }
      visited.add(current.file);

      if (current.depth > 0) {
        importers.add(current.file);
      }

      if (current.depth < maxDepth) {
        const directImporters = reverseGraph.get(current.file);
        if (directImporters) {
          for (const importer of directImporters) {
            if (!visited.has(importer)) {
              queue.push({ file: importer, depth: current.depth + 1 });
            }
          }
        }
      }
    }

    return importers;
  }

  /**
   * Find test files for a given source file
   */
  private findTestsForSource(
    sourceFile: FilePath,
    testFiles: FilePath[],
    reverseImportGraph?: Map<FilePath, Set<FilePath>>
  ): FilePath[] {
    const associated: FilePath[] = [];
    const sourceBaseName = path.basename(sourceFile);
    const sourceDir = path.dirname(sourceFile);
    const sourceNameWithoutExt = sourceBaseName.replace(/\.[^.]+$/, '');

    // Get parse result for the source file to check its symbols
    const sourceParseResult = this.parseResults.find((r) => r.file === sourceFile);

    // Build a set of test file paths for quick lookup
    const testFileSet = new Set(testFiles);

    for (const testFile of testFiles) {
      const testBaseName = path.basename(testFile);
      const testDir = path.dirname(testFile);

      // Strategy 1: Naming conventions
      // Python: test_module.py or module_test.py for module.py
      // Go: module_test.go for module.go
      if (this.matchesTestNamingConvention(sourceNameWithoutExt, testBaseName)) {
        associated.push(testFile);
        continue;
      }

      // Strategy 2: Same directory or tests subdirectory
      const isSameDir = sourceDir === testDir;
      const isInTestsSubdir =
        testDir === path.join(sourceDir, 'tests') ||
        testDir === path.join(sourceDir, 'test') ||
        testDir === path.join(sourceDir, '__tests__');

      if (isSameDir || isInTestsSubdir) {
        // Check if test imports the source module
        const testParseResult = this.parseResults.find((r) => r.file === testFile);
        if (testParseResult && this.testImportsSource(testParseResult, sourceFile)) {
          associated.push(testFile);
          continue;
        }
      }

      // Strategy 3: Check if test file imports symbols from source file
      const testParseResult = this.parseResults.find((r) => r.file === testFile);
      if (
        testParseResult &&
        sourceParseResult &&
        this.testReferencesSourceSymbols(testParseResult, sourceParseResult)
      ) {
        associated.push(testFile);
        continue;
      }

      // Strategy 4: Name-based pattern matching for symbols
      // Match test files that have names containing source symbols (e.g., test_api_route for APIRoute)
      if (sourceParseResult) {
        if (this.testMatchesSourceByNamePattern(testFile, sourceParseResult)) {
          associated.push(testFile);
          continue;
        }
      }
    }

    // Strategy 5: Transitive dependency tracking
    // Find tests that import modules which import the source file
    if (reverseImportGraph) {
      const transitiveImporters = this.findTransitiveImporters(sourceFile, reverseImportGraph, 3);

      for (const importer of transitiveImporters) {
        // Check if this transitive importer is a test file
        if (testFileSet.has(importer) && !associated.includes(importer)) {
          associated.push(importer);
        }
      }
    }

    return [...new Set(associated)]; // Remove duplicates
  }

  /**
   * Check if a test file matches source symbols by name pattern
   * e.g., test_api_route.py or test_application.py for a file with APIRoute class
   */
  private testMatchesSourceByNamePattern(testFile: FilePath, sourceResult: ParseResult): boolean {
    const testBaseName = path.basename(testFile).toLowerCase();

    for (const symbol of sourceResult.symbols) {
      // Only consider classes and major functions
      if (symbol.kind !== 'class' && symbol.kind !== 'function') {
        continue;
      }

      // Convert symbol name to various test patterns
      // e.g., APIRoute -> api_route, apiroute
      const symbolLower = symbol.name.toLowerCase();
      const symbolSnakeCase = this.toSnakeCase(symbol.name).toLowerCase();

      // Check if test file name contains the symbol pattern
      // Patterns like: test_api_route, api_route_test, test_apiroute
      if (
        testBaseName.includes(symbolSnakeCase) ||
        testBaseName.includes(symbolLower) ||
        testBaseName.includes(symbolSnakeCase.replace(/_/g, ''))
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Convert PascalCase or camelCase to snake_case
   */
  private toSnakeCase(str: string): string {
    return str
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase()
      .replace(/^_/, '');
  }

  /**
   * Check if test file name matches naming convention for source file
   */
  private matchesTestNamingConvention(
    sourceNameWithoutExt: string,
    testBaseName: string
  ): boolean {
    // Python conventions
    if (testBaseName === `test_${sourceNameWithoutExt}.py`) return true;
    if (testBaseName === `${sourceNameWithoutExt}_test.py`) return true;

    // Go conventions
    if (testBaseName === `${sourceNameWithoutExt}_test.go`) return true;

    return false;
  }

  /**
   * Check if a test file imports the source file
   */
  private testImportsSource(
    testResult: ParseResult,
    sourceFile: FilePath
  ): boolean {
    const sourceModule = this.fileToModulePath(sourceFile);

    for (const imp of testResult.imports) {
      if (imp.source.includes(sourceModule) || sourceModule.includes(imp.source)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if test references symbols from source
   */
  private testReferencesSourceSymbols(
    testResult: ParseResult,
    sourceResult: ParseResult
  ): boolean {
    const sourceSymbolNames = new Set(sourceResult.symbols.map((s) => s.name));

    for (const ref of testResult.references) {
      // Check if the reference matches a source symbol
      const refName = ref.symbolId.split('.').pop() || ref.symbolId;
      if (sourceSymbolNames.has(refName)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Convert file path to module path
   */
  private fileToModulePath(filePath: FilePath): string {
    const relativePath = path.relative(this.repoRoot, filePath);
    return relativePath.replace(/\.[^.]+$/, '').replace(/[/\\]/g, '.');
  }

  /**
   * Check if a file is a test file
   */
  private isTestFile(filePath: FilePath, language: string): boolean {
    const baseName = path.basename(filePath);

    if (language === 'python') {
      return baseName.startsWith('test_') || baseName.endsWith('_test.py');
    }

    if (language === 'typescript' || language === 'javascript') {
      return baseName.includes('.test.') || baseName.includes('.spec.');
    }

    return false;
  }

  /**
   * Check if a function name indicates a test function
   */
  private isTestFunction(name: string, language: string): boolean {
    if (language === 'python') {
      return name.startsWith('test_') || name.startsWith('Test');
    }

    if (language === 'typescript' || language === 'javascript') {
      return name.startsWith('test') || name.startsWith('it') || name.startsWith('describe');
    }

    return false;
  }

  /**
   * Detect entry points (main functions, CLI commands, API handlers)
   */
  detectEntryPoints(): EntryPoints {
    const entries: EntryPoint[] = [];

    for (const result of this.parseResults) {
      // Skip test files
      if (this.isTestFile(result.file, result.language)) {
        // Add test entry points
        for (const symbol of result.symbols) {
          if (this.isTestFunction(symbol.name, result.language)) {
            entries.push({
              file: result.file,
              symbol: symbol.name,
              kind: 'test',
              description: `Test: ${symbol.name}`,
            });
          }
        }
        continue;
      }

      if (result.language === 'python') {
        this.detectPythonEntryPoints(result, entries);
      }
    }

    return { version: '1.0', entries };
  }

  /**
   * Detect Python entry points
   */
  private detectPythonEntryPoints(result: ParseResult, entries: EntryPoint[]): void {
    // Check file content for if __name__ == '__main__'
    try {
      const content = fs.readFileSync(result.file, 'utf-8');

      if (content.includes("if __name__ == '__main__'") ||
          content.includes('if __name__ == "__main__"')) {
        entries.push({
          file: result.file,
          symbol: '__main__',
          kind: 'main',
          description: 'Script entry point',
        });
      }
    } catch {
      // Skip files we can't read
    }

    // Look for decorators indicating CLI or API handlers
    for (const symbol of result.symbols) {
      // Flask/FastAPI route handlers
      if (symbol.signature?.includes('@app.route') ||
          symbol.signature?.includes('@router.') ||
          symbol.docstring?.includes('route') ||
          symbol.docstring?.includes('endpoint')) {
        entries.push({
          file: result.file,
          symbol: symbol.name,
          kind: 'api_handler',
          description: `API handler: ${symbol.name}`,
        });
      }

      // Click CLI commands
      if (symbol.signature?.includes('@click.command') ||
          symbol.signature?.includes('@click.group') ||
          symbol.docstring?.includes('CLI command')) {
        entries.push({
          file: result.file,
          symbol: symbol.name,
          kind: 'cli',
          description: `CLI command: ${symbol.name}`,
        });
      }

      // Argparse-based CLI (often named main or cli)
      if ((symbol.name === 'main' || symbol.name === 'cli') &&
          symbol.kind === 'function') {
        // Check if it's already added
        const exists = entries.some(
          (e) => e.file === result.file && e.symbol === symbol.name
        );
        if (!exists) {
          entries.push({
            file: result.file,
            symbol: symbol.name,
            kind: 'cli',
            description: `Potential CLI entry: ${symbol.name}`,
          });
        }
      }
    }
  }

  /**
   * Find callers of a symbol
   */
  findCallers(symbolName: string): Reference[] {
    const index = this.buildIndex();
    const callers: Reference[] = [];

    // Find all symbol IDs matching the name
    const matchingIds: SymbolId[] = [];
    for (const [id, symbol] of Object.entries(index.symbols)) {
      if (symbol.name === symbolName || symbol.name.endsWith(`.${symbolName}`)) {
        matchingIds.push(id);
      }
    }

    // Collect all references to matching symbols
    for (const id of matchingIds) {
      if (index.references[id]) {
        callers.push(...index.references[id]);
      }
    }

    return callers;
  }

  /**
   * Trace path from entry point to target symbol using BFS
   */
  tracePath(from: string, to: string, maxDepth: number = 10): string[] | null {
    const index = this.buildIndex();

    // Find symbol IDs for from and to
    const fromIds = this.findSymbolIds(from, index);
    const toIds = this.findSymbolIds(to, index);

    if (fromIds.length === 0 || toIds.length === 0) {
      return null;
    }

    const toIdSet = new Set(toIds);

    // Build a call graph: symbol -> symbols it calls
    const callGraph = this.buildCallGraph(index);

    // BFS to find shortest path
    for (const startId of fromIds) {
      const visited = new Set<string>();
      const queue: { id: string; path: string[] }[] = [{ id: startId, path: [startId] }];

      while (queue.length > 0) {
        const current = queue.shift()!;

        if (current.path.length > maxDepth) {
          continue;
        }

        if (toIdSet.has(current.id)) {
          // Found! Convert IDs to readable names
          return current.path.map((id) => {
            const symbol = index.symbols[id];
            return symbol ? `${symbol.name} (${symbol.file}:${symbol.line})` : id;
          });
        }

        if (visited.has(current.id)) {
          continue;
        }
        visited.add(current.id);

        // Get symbols called by current symbol
        const calls = callGraph.get(current.id) || [];
        for (const calledId of calls) {
          if (!visited.has(calledId)) {
            queue.push({
              id: calledId,
              path: [...current.path, calledId],
            });
          }
        }
      }
    }

    return null;
  }

  /**
   * Find symbol IDs matching a name
   */
  private findSymbolIds(name: string, index: StructureIndex): SymbolId[] {
    const ids: SymbolId[] = [];

    for (const [id, symbol] of Object.entries(index.symbols)) {
      if (
        symbol.name === name ||
        symbol.name.endsWith(`.${name}`) ||
        id.includes(`:${name}:`)
      ) {
        ids.push(id);
      }
    }

    return ids;
  }

  /**
   * Build a call graph from the index
   */
  private buildCallGraph(index: StructureIndex): Map<SymbolId, SymbolId[]> {
    const graph = new Map<SymbolId, SymbolId[]>();

    // For each file, find which symbols call which other symbols
    for (const [filePath, fileInfo] of Object.entries(index.files)) {
      // Get symbols defined in this file
      const fileSymbols = fileInfo.symbols;

      // For each reference in this file, attribute it to a containing symbol
      const parseResult = this.parseResults.find((r) => r.file === filePath);
      if (!parseResult) continue;

      for (const ref of parseResult.references) {
        if (ref.kind !== 'call') continue;

        // Find which symbol in this file contains this reference (by line number)
        const containingSymbol = this.findContainingSymbol(
          ref.line,
          fileSymbols,
          index.symbols
        );

        if (containingSymbol) {
          // Find the target symbol ID
          const targetIds = index.references[ref.symbolId]
            ? [ref.symbolId]
            : this.findSymbolIds(ref.symbolId, index);

          for (const targetId of targetIds) {
            if (!graph.has(containingSymbol)) {
              graph.set(containingSymbol, []);
            }
            if (!graph.get(containingSymbol)!.includes(targetId)) {
              graph.get(containingSymbol)!.push(targetId);
            }
          }
        }
      }
    }

    return graph;
  }

  /**
   * Find which symbol contains a given line number
   */
  private findContainingSymbol(
    line: number,
    symbolIds: SymbolId[],
    symbols: Record<SymbolId, SymbolInfo>
  ): SymbolId | null {
    let best: SymbolId | null = null;
    let bestRange = Infinity;

    for (const id of symbolIds) {
      const symbol = symbols[id];
      if (!symbol) continue;

      if (symbol.line <= line && (symbol.endLine || symbol.line) >= line) {
        const range = (symbol.endLine || symbol.line) - symbol.line;
        if (range < bestRange) {
          best = id;
          bestRange = range;
        }
      }
    }

    return best;
  }

  /**
   * Find files related to a given file
   */
  findRelatedFiles(filePath: string): { file: string; relationship: FileRelationship }[] {
    const index = this.buildIndex();
    const related: { file: string; relationship: FileRelationship }[] = [];
    const absolutePath = path.resolve(this.repoRoot, filePath);

    const fileInfo = index.files[absolutePath];
    if (!fileInfo) {
      return related;
    }

    // Files this file imports
    for (const imp of fileInfo.imports) {
      const importedFiles = this.resolveImportToFiles(imp.source, absolutePath, index);
      for (const importedFile of importedFiles) {
        related.push({ file: importedFile, relationship: 'imports' });
      }
    }

    // Files that import this file
    for (const [otherPath, otherInfo] of Object.entries(index.files)) {
      if (otherPath === absolutePath) continue;

      for (const imp of otherInfo.imports) {
        const importedFiles = this.resolveImportToFiles(imp.source, otherPath, index);
        if (importedFiles.includes(absolutePath)) {
          related.push({ file: otherPath, relationship: 'imported_by' });
          break;
        }
      }
    }

    // Files in the same module/directory
    const fileDir = path.dirname(absolutePath);
    for (const [otherPath] of Object.entries(index.files)) {
      if (otherPath === absolutePath) continue;

      if (path.dirname(otherPath) === fileDir) {
        // Don't add if already related by import
        if (!related.some((r) => r.file === otherPath)) {
          related.push({ file: otherPath, relationship: 'same_module' });
        }
      }
    }

    return related;
  }

  /**
   * Resolve an import source to actual file paths
   */
  private resolveImportToFiles(
    importSource: string,
    _fromFile: string,
    index: StructureIndex
  ): FilePath[] {
    const files: FilePath[] = [];

    // Convert import source to possible file paths
    const modulePath = importSource.replace(/\./g, path.sep);

    for (const filePath of Object.keys(index.files)) {
      if (
        filePath.includes(modulePath) ||
        filePath.endsWith(`${modulePath}.py`) ||
        filePath.endsWith(`${modulePath}.go`)
      ) {
        files.push(filePath);
      }
    }

    return files;
  }

  /**
   * Write all artifacts to .agent/ directory
   * Returns the index for use by other analyzers (avoids re-reading large files)
   * @param outputDir - Directory to write artifacts to
   * @param noContext - If true, skip including context/samples in index to reduce size
   */
  async writeArtifacts(outputDir: string, noContext: boolean = false): Promise<StructureIndex> {
    // Create output directory
    fs.mkdirSync(outputDir, { recursive: true });
    this.outputDir = outputDir;

    // Determine error log path (same directory as the index)
    const errorLogPath = path.join(outputDir, 'parse-errors.log');

    // Parse all files
    await this.parseAll(errorLogPath);

    // Build and write index with relative paths for portability
    // Use streaming JSON to handle very large repos (Django, Linux, etc.)
    const index = this.buildIndex();
    const relativeIndex = this.convertIndexToRelativePaths(index);
    this.writeIndexStreaming(path.join(outputDir, 'index.json'), relativeIndex);

    // Build and write test map with relative paths
    const testMap = this.buildTestMap();
    const relativeTestMap = this.convertTestMapToRelativePaths(testMap);
    fs.writeFileSync(
      path.join(outputDir, 'test-map.json'),
      JSON.stringify(relativeTestMap, null, 2)
    );

    // Detect and write entry points with relative paths
    const entryPoints = this.detectEntryPoints();
    const relativeEntryPoints = this.convertEntryPointsToRelativePaths(entryPoints);
    fs.writeFileSync(
      path.join(outputDir, 'entrypoints.json'),
      JSON.stringify(relativeEntryPoints, null, 2)
    );

    return relativeIndex;
  }

  /**
   * Write index to file using streaming to avoid string length limits
   */
  private writeIndexStreaming(filePath: string, index: StructureIndex): void {
    const fd = fs.openSync(filePath, 'w');

    try {
      // Write header
      fs.writeSync(fd, '{"version":');
      fs.writeSync(fd, JSON.stringify(index.version));
      fs.writeSync(fd, ',"generated":');
      fs.writeSync(fd, JSON.stringify(index.generated));
      fs.writeSync(fd, ',"repoRoot":');
      fs.writeSync(fd, JSON.stringify(index.repoRoot));
      fs.writeSync(fd, ',"languages":');
      fs.writeSync(fd, JSON.stringify(index.languages));

      // Write files object
      fs.writeSync(fd, ',"files":{');
      const fileKeys = Object.keys(index.files);
      for (let i = 0; i < fileKeys.length; i++) {
        if (i > 0) fs.writeSync(fd, ',');
        fs.writeSync(fd, JSON.stringify(fileKeys[i]) + ':' + JSON.stringify(index.files[fileKeys[i]]));
      }
      fs.writeSync(fd, '}');

      // Write symbols object
      fs.writeSync(fd, ',"symbols":{');
      const symbolKeys = Object.keys(index.symbols);
      for (let i = 0; i < symbolKeys.length; i++) {
        if (i > 0) fs.writeSync(fd, ',');
        fs.writeSync(fd, JSON.stringify(symbolKeys[i]) + ':' + JSON.stringify(index.symbols[symbolKeys[i]]));
      }
      fs.writeSync(fd, '}');

      // Write references object (the largest section)
      fs.writeSync(fd, ',"references":{');
      const refKeys = Object.keys(index.references);
      for (let i = 0; i < refKeys.length; i++) {
        if (i > 0) fs.writeSync(fd, ',');
        fs.writeSync(fd, JSON.stringify(refKeys[i]) + ':' + JSON.stringify(index.references[refKeys[i]]));
      }
      fs.writeSync(fd, '}');

      // Write modules object
      fs.writeSync(fd, ',"modules":{');
      const moduleKeys = Object.keys(index.modules);
      for (let i = 0; i < moduleKeys.length; i++) {
        if (i > 0) fs.writeSync(fd, ',');
        fs.writeSync(fd, JSON.stringify(moduleKeys[i]) + ':' + JSON.stringify(index.modules[moduleKeys[i]]));
      }
      fs.writeSync(fd, '}}');
    } finally {
      fs.closeSync(fd);
    }

    // Check file size and warn if it's too large
    this.checkAndWarnIndexSize(filePath);
  }

  /**
   * Check index file size and warn if it exceeds limits
   */
  private checkAndWarnIndexSize(indexPath: string): void {
    try {
      const stats = fs.statSync(indexPath);
      const indexSize = stats.size;
      const indexSizeGB = indexSize / 1e9;

      // Warn at 500MB
      if (indexSize > 500_000_000) {
        console.warn(`Warning: Index size (${indexSizeGB.toFixed(2)}GB) exceeds recommended limit.`);
        console.warn(`Consider using --no-context flag to reduce size.`);
      }

      // Error at 1GB
      if (indexSize > 1_000_000_000) {
        console.error(`Error: Index size exceeds JavaScript string limit.`);
        console.error(`Some MCP tools may fail due to JavaScript memory limits.`);
        console.error(`Recommended: Re-run with --no-context flag.`);
      }
    } catch {
      // Silently fail if we can't read the file stats
    }
  }

  /**
   * Convert an absolute file path to a path relative to the repo root
   */
  private toRelativePath(absolutePath: string): string {
    if (path.isAbsolute(absolutePath)) {
      return path.relative(this.repoRoot, absolutePath);
    }
    return absolutePath;
  }

  /**
   * Convert a symbol ID to use relative paths
   * Symbol IDs have format: filepath:name:line
   */
  private convertSymbolIdToRelative(symbolId: SymbolId): SymbolId {
    const parts = symbolId.split(':');
    if (parts.length >= 1) {
      parts[0] = this.toRelativePath(parts[0]);
    }
    return parts.join(':');
  }

  /**
   * Convert the structure index to use relative paths
   */
  private convertIndexToRelativePaths(index: StructureIndex): StructureIndex {
    // Convert files map
    const relativeFiles: Record<FilePath, FileInfo> = {};
    for (const [filePath, fileInfo] of Object.entries(index.files)) {
      const relativePath = this.toRelativePath(filePath);
      relativeFiles[relativePath] = {
        ...fileInfo,
        path: relativePath,
        symbols: fileInfo.symbols.map((id) => this.convertSymbolIdToRelative(id)),
      };
    }

    // Convert symbols map
    const relativeSymbols: Record<SymbolId, SymbolInfo> = {};
    for (const [symbolId, symbolInfo] of Object.entries(index.symbols)) {
      const relativeId = this.convertSymbolIdToRelative(symbolId);
      relativeSymbols[relativeId] = {
        ...symbolInfo,
        id: relativeId,
        file: this.toRelativePath(symbolInfo.file),
      };
    }

    // Convert references map
    const relativeReferences: Record<SymbolId, Reference[]> = {};
    for (const [symbolId, refs] of Object.entries(index.references)) {
      const relativeId = this.convertSymbolIdToRelative(symbolId);
      relativeReferences[relativeId] = refs.map((ref) => ({
        ...ref,
        symbolId: this.convertSymbolIdToRelative(ref.symbolId),
        file: this.toRelativePath(ref.file),
      }));
    }

    // Convert modules map
    const relativeModules: Record<string, InternalModuleInfo> = {};
    for (const [modulePath, moduleInfo] of Object.entries(index.modules)) {
      relativeModules[modulePath] = {
        ...moduleInfo,
        files: moduleInfo.files.map((f) => this.toRelativePath(f)),
        exports: moduleInfo.exports.map((id) => this.convertSymbolIdToRelative(id)),
      };
    }

    return {
      ...index,
      repoRoot: '.', // Use relative root marker for portability
      files: relativeFiles,
      symbols: relativeSymbols,
      references: relativeReferences,
      modules: relativeModules,
    };
  }

  /**
   * Convert the test map to use relative paths
   */
  private convertTestMapToRelativePaths(testMap: TestMap): TestMap {
    return {
      ...testMap,
      mappings: testMap.mappings.map((mapping) => ({
        ...mapping,
        sourceFile: this.toRelativePath(mapping.sourceFile),
        testFiles: mapping.testFiles.map((f) => this.toRelativePath(f)),
      })),
    };
  }

  /**
   * Convert entry points to use relative paths
   */
  private convertEntryPointsToRelativePaths(entryPoints: EntryPoints): EntryPoints {
    return {
      ...entryPoints,
      entries: entryPoints.entries.map((entry) => ({
        ...entry,
        file: this.toRelativePath(entry.file),
      })),
    };
  }

  /**
   * Get parse results (useful for testing)
   */
  getParseResults(): ParseResult[] {
    return this.parseResults;
  }

  /**
   * Get detected languages
   */
  getLanguages(): string[] {
    return this.languages;
  }

  /**
   * Collect statistics from the index for validation output
   */
  collectStats(index: StructureIndex, agentDir: string): IndexStats {
    // Count files and errors
    const totalFiles = Object.keys(index.files).length;
    const parseErrors: string[] = [];

    // Check parse results for errors
    for (const result of this.parseResults) {
      if (result.errors && result.errors.length > 0) {
        parseErrors.push(...result.errors.map(err => `${result.file}: ${err}`));
      }
    }

    const filesWithErrors = parseErrors.length;
    const filesParsed = totalFiles;

    // Count symbols by kind
    const symbolCounts = {
      total: 0,
      functions: 0,
      classes: 0,
      methods: 0,
      variables: 0,
      types: 0,
      components: 0,
      hooks: 0,
      interfaces: 0,
      typeAliases: 0,
      enums: 0,
      namespaces: 0,
    };

    for (const symbol of Object.values(index.symbols)) {
      symbolCounts.total++;
      switch (symbol.kind) {
        case 'function':
          symbolCounts.functions++;
          break;
        case 'class':
          symbolCounts.classes++;
          break;
        case 'method':
          symbolCounts.methods++;
          break;
        case 'variable':
          symbolCounts.variables++;
          break;
        case 'type':
          symbolCounts.types++;
          break;
        case 'component':
          symbolCounts.components++;
          break;
        case 'hook':
          symbolCounts.hooks++;
          break;
        case 'interface':
          symbolCounts.interfaces++;
          break;
        case 'type_alias':
          symbolCounts.typeAliases++;
          break;
        case 'enum':
          symbolCounts.enums++;
          break;
        case 'namespace':
          symbolCounts.namespaces++;
          break;
      }
    }

    // Count references by kind
    let totalReferences = 0;
    let callReferences = 0;
    let importReferences = 0;
    for (const refs of Object.values(index.references)) {
      for (const ref of refs) {
        totalReferences++;
        if (ref.kind === 'call') {
          callReferences++;
        } else if (ref.kind === 'import') {
          importReferences++;
        }
      }
    }

    // Get index file size
    let indexSizeBytes = 0;
    const indexPath = path.join(agentDir, 'index.json');
    try {
      const stats = fs.statSync(indexPath);
      indexSizeBytes = stats.size;
    } catch {
      // File might not exist yet or error reading
    }

    return {
      files: {
        total: totalFiles,
        parsed: filesParsed,
        errors: filesWithErrors,
      },
      symbols: symbolCounts,
      references: {
        total: totalReferences,
        calls: callReferences,
        imports: importReferences,
      },
      indexSizeBytes,
      parseErrors,
    };
  }

  /**
   * Get parse results for error tracking
   */
  getParseErrors(): string[] {
    const errors: string[] = [];
    for (const result of this.parseResults) {
      if (result.errors && result.errors.length > 0) {
        errors.push(...result.errors.map(err => `${result.file}: ${err}`));
      }
    }
    return errors;
  }
}

// =============================================================================
// Standalone functions for use by MCP tools
// =============================================================================

/**
 * Size threshold for using streaming parser (100MB)
 * Files larger than this will use streaming to avoid V8 string length limits
 */
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100MB

/**
 * Load the structure index from the .agent directory using streaming JSON parser
 * This handles large files (>100MB) that would crash with synchronous parsing
 * due to V8's string length limit of ~536MB.
 *
 * @param agentDir - Path to the .agentifind directory
 * @returns Promise resolving to the StructureIndex
 */
export async function loadIndexStreaming(agentDir: string): Promise<StructureIndex> {
  const indexPath = path.join(agentDir, 'index.json');

  if (!fs.existsSync(indexPath)) {
    throw new Error(`Index file not found: ${indexPath}`);
  }

  return new Promise((resolve, reject) => {
    // Build the index incrementally from the stream
    const index: StructureIndex = {
      version: '',
      generated: '',
      repoRoot: '',
      languages: [],
      files: {},
      symbols: {},
      references: {},
      modules: {},
    };

    const readStream = fs.createReadStream(indexPath, { encoding: 'utf-8' });
    const jsonParser = parser();
    const objectStream = streamObject();

    const pipeline = readStream.pipe(jsonParser).pipe(objectStream);

    pipeline.on('data', ({ key, value }: { key: string; value: unknown }) => {
      switch (key) {
        case 'version':
          index.version = value as string;
          break;
        case 'generated':
          index.generated = value as string;
          break;
        case 'repoRoot':
          index.repoRoot = value as string;
          break;
        case 'languages':
          index.languages = value as string[];
          break;
        case 'files':
          index.files = value as Record<FilePath, FileInfo>;
          break;
        case 'symbols':
          index.symbols = value as Record<SymbolId, SymbolInfo>;
          break;
        case 'references':
          index.references = value as Record<SymbolId, Reference[]>;
          break;
        case 'modules':
          index.modules = value as Record<string, InternalModuleInfo>;
          break;
      }
    });

    pipeline.on('end', () => {
      resolve(index);
    });

    pipeline.on('error', (error: Error) => {
      reject(new Error(`Failed to load index: ${error.message}`));
    });

    readStream.on('error', (error: Error) => {
      reject(new Error(`Failed to read index file: ${error.message}`));
    });
  });
}

/**
 * Load the structure index from the .agent directory
 * For small files (<100MB), uses fast synchronous parsing.
 * For large files (>=100MB), uses streaming to avoid V8 string length limits.
 *
 * @param agentDir - Path to the .agentifind directory
 * @returns StructureIndex (sync for small files) or Promise<StructureIndex> (for large files)
 */
export function loadIndex(agentDir: string): StructureIndex {
  const indexPath = path.join(agentDir, 'index.json');

  if (!fs.existsSync(indexPath)) {
    throw new Error(`Index file not found: ${indexPath}`);
  }

  // Check file size to determine parsing strategy
  const stats = fs.statSync(indexPath);
  if (stats.size >= LARGE_FILE_THRESHOLD) {
    // For large files, we can't return synchronously
    // Callers should use loadIndexAsync() for potentially large files
    throw new Error(
      `Index file is too large (${Math.round(stats.size / 1024 / 1024)}MB) for synchronous loading. ` +
      `Use loadIndexAsync() instead.`
    );
  }

  try {
    const content = fs.readFileSync(indexPath, 'utf-8');
    return JSON.parse(content) as StructureIndex;
  } catch (error) {
    throw new Error(
      `Failed to load index: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load the structure index from the .agent directory (async version)
 * Automatically uses streaming for large files to avoid V8 string length limits.
 *
 * @param agentDir - Path to the .agentifind directory
 * @returns Promise resolving to the StructureIndex
 */
export async function loadIndexAsync(agentDir: string): Promise<StructureIndex> {
  const indexPath = path.join(agentDir, 'index.json');

  if (!fs.existsSync(indexPath)) {
    throw new Error(`Index file not found: ${indexPath}`);
  }

  // Check file size to determine parsing strategy
  const stats = fs.statSync(indexPath);
  if (stats.size >= LARGE_FILE_THRESHOLD) {
    // Use streaming parser for large files
    return loadIndexStreaming(agentDir);
  }

  // Use fast synchronous parsing for small files
  try {
    const content = fs.readFileSync(indexPath, 'utf-8');
    return JSON.parse(content) as StructureIndex;
  } catch (error) {
    throw new Error(
      `Failed to load index: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load the test map from the .agent directory
 */
export function loadTestMap(agentDir: string): TestMap {
  const testMapPath = path.join(agentDir, 'test-map.json');

  if (!fs.existsSync(testMapPath)) {
    throw new Error(`Test map file not found: ${testMapPath}`);
  }

  try {
    const content = fs.readFileSync(testMapPath, 'utf-8');
    return JSON.parse(content) as TestMap;
  } catch (error) {
    throw new Error(
      `Failed to load test map: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load entry points from the .agent directory
 */
export function loadEntryPoints(agentDir: string): EntryPoints {
  const entryPointsPath = path.join(agentDir, 'entrypoints.json');

  if (!fs.existsSync(entryPointsPath)) {
    throw new Error(`Entry points file not found: ${entryPointsPath}`);
  }

  try {
    const content = fs.readFileSync(entryPointsPath, 'utf-8');
    return JSON.parse(content) as EntryPoints;
  } catch (error) {
    throw new Error(
      `Failed to load entry points: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Find callers of a symbol using the pre-built index
 */
export function findCallersFromIndex(
  agentDir: string,
  symbolName: string
): Reference[] {
  const index = loadIndex(agentDir);
  const callers: Reference[] = [];

  // Find all symbol IDs matching the name
  for (const [id, symbol] of Object.entries(index.symbols)) {
    if (symbol.name === symbolName || symbol.name.endsWith(`.${symbolName}`)) {
      if (index.references[id]) {
        callers.push(...index.references[id]);
      }
    }
  }

  return callers;
}

/**
 * Get tests for a file using the pre-built test map
 */
export function getTestsForFile(agentDir: string, filePath: string): TestMapping | null {
  const testMap = loadTestMap(agentDir);

  // Normalize the file path
  const normalizedPath = path.resolve(filePath);

  for (const mapping of testMap.mappings) {
    if (path.resolve(mapping.sourceFile) === normalizedPath) {
      return mapping;
    }
  }

  return null;
}

/**
 * Analyze a repository and generate all artifacts
 */
export async function analyzeRepository(
  repoRoot: string,
  outputDir: string,
  languages?: string[],
  verbose?: boolean
): Promise<{
  index: StructureIndex;
  testMap: TestMap;
  entryPoints: EntryPoints;
}> {
  const analyzer = new StructureAnalyzer(repoRoot, languages, verbose);
  await analyzer.writeArtifacts(outputDir);

  return {
    index: loadIndex(outputDir),
    testMap: loadTestMap(outputDir),
    entryPoints: loadEntryPoints(outputDir),
  };
}
