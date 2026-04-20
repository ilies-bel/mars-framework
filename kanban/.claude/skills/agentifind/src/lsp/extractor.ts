/**
 * LSP-based Code Extractor
 *
 * Uses language servers (pyright, tsserver) to extract accurate
 * code structure with resolved references.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  LSPClient,
  LSPSymbolInformation,
  LSPDocumentSymbol,
  LSPLocation,
  SymbolKind,
  commandExists,
} from './client.js';
import type {
  StructureIndex,
  FileInfo,
  SymbolInfo,
  Reference,
  InternalModuleInfo,
  SymbolKind as AppSymbolKind,
  ReferenceKind,
  Import,
} from '../types.js';

/**
 * Directories to skip when scanning
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
]);

/**
 * Map LSP SymbolKind to our SymbolKind
 */
function mapSymbolKind(kind: number): AppSymbolKind {
  switch (kind) {
    case SymbolKind.Function:
      return 'function';
    case SymbolKind.Method:
      return 'method';
    case SymbolKind.Class:
      return 'class';
    case SymbolKind.Variable:
    case SymbolKind.Constant:
      return 'variable';
    case SymbolKind.Interface:
      return 'interface';
    case SymbolKind.Enum:
      return 'enum';
    case SymbolKind.Module:
    case SymbolKind.Namespace:
      return 'namespace';
    default:
      return 'variable';
  }
}

/**
 * Convert file path to URI
 */
function pathToUri(filePath: string): string {
  return `file://${path.resolve(filePath)}`;
}

/**
 * Convert URI to file path
 */
function uriToPath(uri: string): string {
  return uri.replace('file://', '');
}

/**
 * Extract code structure using LSP
 */
export class LSPExtractor {
  private client: LSPClient | null = null;
  private repoRoot: string;
  private language: 'python' | 'typescript';

  constructor(repoRoot: string, language: 'python' | 'typescript') {
    this.repoRoot = path.resolve(repoRoot);
    this.language = language;
  }

  /**
   * Check if the required language server is available
   */
  static async isAvailable(language: 'python' | 'typescript'): Promise<boolean> {
    if (language === 'python') {
      // Check for pyright or pylsp
      return await commandExists('pyright-langserver') ||
             await commandExists('pyright');
    } else {
      // TypeScript server is bundled with typescript
      try {
        require.resolve('typescript');
        return true;
      } catch {
        return await commandExists('tsserver');
      }
    }
  }

  /**
   * Start the language server
   */
  async start(): Promise<void> {
    if (this.language === 'python') {
      // Try pyright-langserver first, then basedpyright
      if (await commandExists('pyright-langserver')) {
        this.client = new LSPClient('pyright-langserver', ['--stdio'], this.repoRoot);
      } else if (await commandExists('basedpyright-langserver')) {
        this.client = new LSPClient('basedpyright-langserver', ['--stdio'], this.repoRoot);
      } else {
        throw new Error('pyright-langserver not found. Install with: npm install -g pyright');
      }
    } else {
      // TypeScript
      const tsserverPath = this.findTsserver();
      if (!tsserverPath) {
        throw new Error('tsserver not found. Install with: npm install typescript');
      }
      this.client = new LSPClient('node', [tsserverPath, '--stdio'], this.repoRoot);
    }

    await this.client.start();
  }

  /**
   * Find tsserver path
   */
  private findTsserver(): string | null {
    // Try local node_modules first
    const localPath = path.join(this.repoRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js');
    if (fs.existsSync(localPath)) return localPath;

    // Try global
    try {
      const typescriptPath = require.resolve('typescript');
      return path.join(path.dirname(typescriptPath), 'tsserver.js');
    } catch {
      return null;
    }
  }

  /**
   * Stop the language server
   */
  async stop(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
  }

  /**
   * Extract structure from the codebase
   */
  async extract(): Promise<StructureIndex> {
    if (!this.client) {
      throw new Error('LSP client not started');
    }

    const files: Record<string, FileInfo> = {};
    const symbols: Record<string, SymbolInfo> = {};
    const references: Record<string, Reference[]> = {};
    const modules: Record<string, InternalModuleInfo> = {};

    // Get all source files
    const sourceFiles = this.findSourceFiles();
    console.log(`[LSP] Found ${sourceFiles.length} source files`);

    // Get workspace symbols for quick overview
    console.log('[LSP] Fetching workspace symbols...');
    const workspaceSymbols = await this.client.workspaceSymbols('');
    console.log(`[LSP] Found ${workspaceSymbols.length} workspace symbols`);

    // Process each file
    let processed = 0;
    for (const filePath of sourceFiles) {
      const relativePath = path.relative(this.repoRoot, filePath);
      const uri = pathToUri(filePath);

      // Read file content
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').length;

      // Open document in LSP
      this.client.openDocument(uri, content, this.language === 'python' ? 'python' : 'typescript');

      // Get document symbols
      let docSymbols: (LSPDocumentSymbol | LSPSymbolInformation)[] = [];
      try {
        docSymbols = await this.client.documentSymbols(uri);
      } catch (err) {
        // Some files might fail - continue with what we have
      }

      // Extract symbols from document
      const fileSymbolIds: string[] = [];
      const fileImports = this.extractImports(content, this.language);

      this.processDocumentSymbols(
        docSymbols,
        relativePath,
        symbols,
        fileSymbolIds
      );

      // Build file info
      files[relativePath] = {
        path: relativePath,
        language: this.language,
        lines,
        symbols: fileSymbolIds,
        imports: fileImports,
      };

      // Build module info
      const moduleDir = path.dirname(relativePath);
      if (!modules[moduleDir]) {
        modules[moduleDir] = {
          path: moduleDir,
          files: [],
          exports: [],
          isPublic: !moduleDir.startsWith('_') && !moduleDir.includes('test'),
        };
      }
      modules[moduleDir].files.push(relativePath);

      // Close document
      this.client.closeDocument(uri);

      processed++;
      if (processed % 100 === 0) {
        console.log(`[LSP] Processed ${processed}/${sourceFiles.length} files`);
      }
    }

    // Now get references for key symbols
    console.log('[LSP] Building reference graph...');
    await this.buildReferenceGraph(symbols, references, sourceFiles);

    return {
      version: '1.0',
      generated: new Date().toISOString(),
      repoRoot: '.',
      languages: [this.language],
      files,
      symbols,
      references,
      modules,
    };
  }

  /**
   * Process document symbols recursively
   */
  private processDocumentSymbols(
    docSymbols: (LSPDocumentSymbol | LSPSymbolInformation)[],
    filePath: string,
    symbols: Record<string, SymbolInfo>,
    fileSymbolIds: string[],
    containerName?: string
  ): void {
    for (const sym of docSymbols) {
      // Handle both flat (SymbolInformation) and hierarchical (DocumentSymbol) formats
      const isDocSymbol = 'range' in sym && !('location' in sym);

      const name = containerName ? `${containerName}.${sym.name}` : sym.name;
      const line = isDocSymbol
        ? (sym as LSPDocumentSymbol).range.start.line + 1
        : (sym as LSPSymbolInformation).location.range.start.line + 1;
      const endLine = isDocSymbol
        ? (sym as LSPDocumentSymbol).range.end.line + 1
        : (sym as LSPSymbolInformation).location.range.end.line + 1;

      const symbolId = `${filePath}:${name}:${line}`;
      const kind = mapSymbolKind(sym.kind);

      // Skip certain kinds
      if (kind === 'variable' && !name.toUpperCase().includes(name)) {
        // Skip lowercase variables, keep constants
        continue;
      }

      symbols[symbolId] = {
        id: symbolId,
        name,
        kind,
        file: filePath,
        line,
        endLine,
        exported: this.isExported(name, kind),
      };

      fileSymbolIds.push(symbolId);

      // Process children (for DocumentSymbol)
      if (isDocSymbol && (sym as LSPDocumentSymbol).children) {
        this.processDocumentSymbols(
          (sym as LSPDocumentSymbol).children!,
          filePath,
          symbols,
          fileSymbolIds,
          name
        );
      }
    }
  }

  /**
   * Determine if a symbol is exported
   */
  private isExported(name: string, kind: AppSymbolKind): boolean {
    // In Python, non-underscore prefixed names are public
    if (this.language === 'python') {
      return !name.startsWith('_');
    }
    // In TypeScript, classes and exported functions are public
    return kind === 'class' || kind === 'function' || kind === 'interface';
  }

  /**
   * Build reference graph using LSP references
   */
  private async buildReferenceGraph(
    symbols: Record<string, SymbolInfo>,
    references: Record<string, Reference[]>,
    sourceFiles: string[]
  ): Promise<void> {
    if (!this.client) return;

    // Get references for functions and methods (most important for call graph)
    const targetSymbols = Object.values(symbols).filter(
      s => s.kind === 'function' || s.kind === 'method' || s.kind === 'class'
    );

    console.log(`[LSP] Getting references for ${targetSymbols.length} symbols...`);

    let processed = 0;
    for (const sym of targetSymbols) {
      const uri = pathToUri(path.join(this.repoRoot, sym.file));
      const position = { line: sym.line - 1, character: 0 };

      try {
        // Open the file first
        const content = fs.readFileSync(path.join(this.repoRoot, sym.file), 'utf-8');
        this.client.openDocument(uri, content, this.language === 'python' ? 'python' : 'typescript');

        // Find column position of symbol name
        const lines = content.split('\n');
        const targetLine = lines[sym.line - 1] || '';
        const nameMatch = targetLine.indexOf(sym.name.split('.').pop() || sym.name);
        if (nameMatch !== -1) {
          position.character = nameMatch;
        }

        const refs = await this.client.references(uri, position, false);

        if (refs && refs.length > 0) {
          references[sym.id] = refs.map(ref => ({
            symbolId: sym.id,
            file: path.relative(this.repoRoot, uriToPath(ref.uri)),
            line: ref.range.start.line + 1,
            kind: 'call' as ReferenceKind,
          }));
        }

        this.client.closeDocument(uri);
      } catch (err) {
        // Skip symbols that fail
      }

      processed++;
      if (processed % 50 === 0) {
        console.log(`[LSP] References: ${processed}/${targetSymbols.length}`);
      }
    }
  }

  /**
   * Extract imports from file content (simple regex-based)
   */
  private extractImports(content: string, language: 'python' | 'typescript'): Import[] {
    const imports: Import[] = [];

    if (language === 'python') {
      // Match: from X import Y, from X import Y as Z, import X
      const importRegex = /^(?:from\s+([\w.]+)\s+)?import\s+(.+)$/gm;
      let match;
      let line = 1;

      for (const lineContent of content.split('\n')) {
        const trimmed = lineContent.trim();
        if (trimmed.startsWith('from ') || trimmed.startsWith('import ')) {
          const importMatch = /^(?:from\s+([\w.]+)\s+)?import\s+(.+)$/.exec(trimmed);
          if (importMatch) {
            const source = importMatch[1] || importMatch[2].split(/[,\s]/)[0];
            imports.push({
              source: source.trim(),
              symbols: [],
              line,
            });
          }
        }
        line++;
      }
    } else {
      // TypeScript/JavaScript
      const importRegex = /import\s+(?:(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
      let match;
      let line = 1;

      for (const lineContent of content.split('\n')) {
        const importMatch = /import\s+(?:(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/.exec(lineContent);
        if (importMatch) {
          imports.push({
            source: importMatch[1],
            symbols: [],
            line,
          });
        }
        line++;
      }
    }

    return imports;
  }

  /**
   * Find all source files in the repo
   */
  private findSourceFiles(): string[] {
    const files: string[] = [];
    const ext = this.language === 'python' ? '.py' : '.ts';
    const extAlt = this.language === 'typescript' ? '.tsx' : null;

    const walk = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
              walk(path.join(dir, entry.name));
            }
          } else if (entry.isFile()) {
            if (entry.name.endsWith(ext) || (extAlt && entry.name.endsWith(extAlt))) {
              files.push(path.join(dir, entry.name));
            }
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    walk(this.repoRoot);
    return files;
  }
}

/**
 * Try to extract using LSP, returns null if not available
 */
export async function extractWithLSP(
  repoRoot: string,
  language: 'python' | 'typescript'
): Promise<StructureIndex | null> {
  // Check if LSP is available
  const available = await LSPExtractor.isAvailable(language);
  if (!available) {
    console.log(`[LSP] ${language} language server not available`);
    return null;
  }

  const extractor = new LSPExtractor(repoRoot, language);

  try {
    console.log(`[LSP] Starting ${language} language server...`);
    await extractor.start();

    console.log('[LSP] Extracting code structure...');
    const index = await extractor.extract();

    await extractor.stop();
    console.log('[LSP] Extraction complete');

    return index;
  } catch (err) {
    console.log(`[LSP] Failed: ${err instanceof Error ? err.message : err}`);
    await extractor.stop().catch(() => {});
    return null;
  }
}
