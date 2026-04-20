/**
 * Terraform/HCL Parser
 *
 * Parses Terraform configuration files (.tf, .tfvars) using:
 * 1. terraform-ls (HashiCorp's official Language Server) when available
 * 2. Regex-based parsing as fallback
 *
 * terraform-ls provides more accurate parsing with proper HCL understanding,
 * cross-file references, and module resolution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LSPClient, commandExists, LSPDocumentSymbol, SymbolKind } from '../lsp/client.js';
import type { ParseOptions } from '../types.js';

/**
 * Directories to skip when scanning
 */
const SKIP_DIRECTORIES = new Set([
  '.terraform',
  '.git',
  'node_modules',
  '__pycache__',
]);

/**
 * Terraform resource information
 */
export interface TerraformResource {
  type: string;           // e.g., "aws_instance"
  name: string;           // e.g., "web"
  provider: string;       // e.g., "aws"
  file: string;
  line: number;
  dependencies: string[]; // Explicit depends_on
  references: string[];   // Implicit ${...} references
}

/**
 * Terraform module call
 */
export interface TerraformModule {
  name: string;
  source: string;
  file: string;
  line: number;
  variables: Record<string, string>; // Input variable mappings
}

/**
 * Terraform variable definition
 */
export interface TerraformVariable {
  name: string;
  type?: string;
  default?: string;
  description?: string;
  file: string;
  line: number;
}

/**
 * Terraform output definition
 */
export interface TerraformOutput {
  name: string;
  value: string;
  description?: string;
  file: string;
  line: number;
  references: string[];
}

/**
 * Terraform provider configuration
 */
export interface TerraformProvider {
  name: string;
  alias?: string;
  file: string;
  line: number;
}

/**
 * Terraform data source
 */
export interface TerraformDataSource {
  type: string;
  name: string;
  provider: string;
  file: string;
  line: number;
  references: string[];
}

/**
 * Complete Terraform parse result for a file
 */
export interface TerraformParseResult {
  file: string;
  resources: TerraformResource[];
  modules: TerraformModule[];
  variables: TerraformVariable[];
  outputs: TerraformOutput[];
  providers: TerraformProvider[];
  dataSources: TerraformDataSource[];
  locals: Record<string, string>;
  errors?: string[];
}

/**
 * Parse a single Terraform file
 */
export async function parseTerraformFile(
  filePath: string,
  _options?: ParseOptions
): Promise<TerraformParseResult> {
  const result: TerraformParseResult = {
    file: filePath,
    resources: [],
    modules: [],
    variables: [],
    outputs: [],
    providers: [],
    dataSources: [],
    locals: {},
    errors: [],
  };

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Parse resources: resource "type" "name" {
    const resourceRegex = /^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/;
    // Parse modules: module "name" {
    const moduleRegex = /^module\s+"([^"]+)"\s*\{/;
    // Parse variables: variable "name" {
    const variableRegex = /^variable\s+"([^"]+)"\s*\{/;
    // Parse outputs: output "name" {
    const outputRegex = /^output\s+"([^"]+)"\s*\{/;
    // Parse providers: provider "name" {
    const providerRegex = /^provider\s+"([^"]+)"\s*\{/;
    // Parse data sources: data "type" "name" {
    const dataRegex = /^data\s+"([^"]+)"\s+"([^"]+)"\s*\{/;
    // Parse locals: locals {
    const localsRegex = /^locals\s*\{/;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      const lineNum = i + 1;

      // Resource
      let match = line.match(resourceRegex);
      if (match) {
        const [, type, name] = match;
        const blockContent = extractBlock(lines, i);
        const provider = type.split('_')[0];

        result.resources.push({
          type,
          name,
          provider,
          file: filePath,
          line: lineNum,
          dependencies: extractDependsOn(blockContent),
          references: extractReferences(blockContent),
        });
        i += countBlockLines(lines, i);
        continue;
      }

      // Module
      match = line.match(moduleRegex);
      if (match) {
        const [, name] = match;
        const blockContent = extractBlock(lines, i);

        result.modules.push({
          name,
          source: extractAttribute(blockContent, 'source'),
          file: filePath,
          line: lineNum,
          variables: extractVariableMappings(blockContent),
        });
        i += countBlockLines(lines, i);
        continue;
      }

      // Variable
      match = line.match(variableRegex);
      if (match) {
        const [, name] = match;
        const blockContent = extractBlock(lines, i);

        result.variables.push({
          name,
          type: extractAttribute(blockContent, 'type') || undefined,
          default: extractAttribute(blockContent, 'default') || undefined,
          description: extractAttribute(blockContent, 'description') || undefined,
          file: filePath,
          line: lineNum,
        });
        i += countBlockLines(lines, i);
        continue;
      }

      // Output
      match = line.match(outputRegex);
      if (match) {
        const [, name] = match;
        const blockContent = extractBlock(lines, i);
        const value = extractAttribute(blockContent, 'value');

        result.outputs.push({
          name,
          value,
          description: extractAttribute(blockContent, 'description') || undefined,
          file: filePath,
          line: lineNum,
          references: extractReferences(blockContent),
        });
        i += countBlockLines(lines, i);
        continue;
      }

      // Provider
      match = line.match(providerRegex);
      if (match) {
        const [, name] = match;
        const blockContent = extractBlock(lines, i);

        result.providers.push({
          name,
          alias: extractAttribute(blockContent, 'alias') || undefined,
          file: filePath,
          line: lineNum,
        });
        i += countBlockLines(lines, i);
        continue;
      }

      // Data source
      match = line.match(dataRegex);
      if (match) {
        const [, type, name] = match;
        const blockContent = extractBlock(lines, i);
        const provider = type.split('_')[0];

        result.dataSources.push({
          type,
          name,
          provider,
          file: filePath,
          line: lineNum,
          references: extractReferences(blockContent),
        });
        i += countBlockLines(lines, i);
        continue;
      }

      // Locals
      if (localsRegex.test(line)) {
        const blockContent = extractBlock(lines, i);
        const localVars = extractLocalVariables(blockContent);
        Object.assign(result.locals, localVars);
        i += countBlockLines(lines, i);
        continue;
      }

      i++;
    }
  } catch (error) {
    result.errors?.push(`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
}

/**
 * Extract a block starting at the given line index
 */
function extractBlock(lines: string[], startIndex: number): string {
  let depth = 0;
  let started = false;
  const blockLines: string[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    blockLines.push(line);

    // Count braces
    for (const char of line) {
      if (char === '{') {
        depth++;
        started = true;
      } else if (char === '}') {
        depth--;
      }
    }

    if (started && depth === 0) {
      break;
    }
  }

  return blockLines.join('\n');
}

/**
 * Count lines in a block starting at the given line index
 */
function countBlockLines(lines: string[], startIndex: number): number {
  let depth = 0;
  let started = false;
  let count = 0;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    count++;

    for (const char of line) {
      if (char === '{') {
        depth++;
        started = true;
      } else if (char === '}') {
        depth--;
      }
    }

    if (started && depth === 0) {
      break;
    }
  }

  return count;
}

/**
 * Extract an attribute value from block content
 */
function extractAttribute(content: string, name: string): string {
  // Match: name = "value" or name = value
  const regex = new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm');
  const match = content.match(regex);
  if (match) {
    let value = match[1].trim();
    // Remove quotes
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return '';
}

/**
 * Extract depends_on list
 */
function extractDependsOn(content: string): string[] {
  const regex = /depends_on\s*=\s*\[([\s\S]*?)\]/;
  const match = content.match(regex);
  if (match) {
    const listContent = match[1];
    // Extract references from the list
    const refs = listContent.match(/[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*/g);
    return refs || [];
  }
  return [];
}

/**
 * Extract all references (var.x, local.x, resource.x, module.x, data.x)
 */
function extractReferences(content: string): string[] {
  const references: string[] = [];

  // Match var.name, local.name, module.name.output, data.type.name, resource_type.name
  const patterns = [
    /var\.([a-zA-Z_][a-zA-Z0-9_]*)/g,
    /local\.([a-zA-Z_][a-zA-Z0-9_]*)/g,
    /module\.([a-zA-Z_][a-zA-Z0-9_]*)/g,
    /data\.([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)/g,
    /([a-zA-Z]+_[a-zA-Z_]+)\.([a-zA-Z_][a-zA-Z0-9_]*)\./g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match[2]) {
        references.push(`${match[1]}.${match[2]}`);
      } else {
        const prefix = pattern.source.startsWith('var') ? 'var.' :
                      pattern.source.startsWith('local') ? 'local.' :
                      pattern.source.startsWith('module') ? 'module.' : '';
        references.push(`${prefix}${match[1]}`);
      }
    }
  }

  return [...new Set(references)];
}

/**
 * Extract variable mappings from module block
 */
function extractVariableMappings(content: string): Record<string, string> {
  const mappings: Record<string, string> = {};

  // Match: name = value (but not source, version, providers, depends_on)
  const skipKeys = new Set(['source', 'version', 'providers', 'depends_on', 'count', 'for_each']);
  const regex = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/gm;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const [, key, value] = match;
    if (!skipKeys.has(key)) {
      mappings[key] = value.trim();
    }
  }

  return mappings;
}

/**
 * Extract local variable definitions
 */
function extractLocalVariables(content: string): Record<string, string> {
  const locals: Record<string, string> = {};

  // Match: name = value
  const regex = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/gm;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const [, key, value] = match;
    locals[key] = value.trim();
  }

  return locals;
}

/**
 * Parse all Terraform files in a directory
 */
export async function parseTerraformDirectory(
  dirPath: string,
  options?: ParseOptions
): Promise<TerraformParseResult[]> {
  const results: TerraformParseResult[] = [];
  const files = findTerraformFiles(dirPath);

  if (options?.verbose) {
    console.log(`Found ${files.length} Terraform files`);
  }

  for (const file of files) {
    const result = await parseTerraformFile(file, options);
    results.push(result);
  }

  if (options?.verbose) {
    const totalResources = results.reduce((sum, r) => sum + r.resources.length, 0);
    const totalModules = results.reduce((sum, r) => sum + r.modules.length, 0);
    console.log(`Parsed ${totalResources} resources, ${totalModules} modules`);
  }

  return results;
}

/**
 * Find all Terraform files in a directory
 */
function findTerraformFiles(dirPath: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
            walk(path.join(dir, entry.name));
          }
        } else if (entry.isFile()) {
          if (entry.name.endsWith('.tf')) {
            files.push(path.join(dir, entry.name));
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  walk(dirPath);
  return files;
}

/**
 * Check if a directory contains Terraform files
 */
export function hasTerraformFiles(dirPath: string): boolean {
  const files = findTerraformFiles(dirPath);
  return files.length > 0;
}

/**
 * Check if terraform-ls is available
 */
export async function isTerraformLSAvailable(): Promise<boolean> {
  return await commandExists('terraform-ls');
}

/**
 * Terraform LSP-based extractor using terraform-ls
 */
export class TerraformLSPExtractor {
  private client: LSPClient | null = null;
  private repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = path.resolve(repoRoot);
  }

  /**
   * Start the terraform-ls language server
   */
  async start(): Promise<void> {
    this.client = new LSPClient('terraform-ls', ['serve'], this.repoRoot);
    await this.client.start();
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
   * Extract terraform structure using LSP
   */
  async extract(): Promise<TerraformParseResult[]> {
    if (!this.client) {
      throw new Error('Terraform LSP client not started');
    }

    const results: TerraformParseResult[] = [];
    const files = findTerraformFiles(this.repoRoot);

    for (const filePath of files) {
      const uri = `file://${filePath}`;
      const content = fs.readFileSync(filePath, 'utf-8');

      // Open document
      this.client.openDocument(uri, content, 'terraform');

      // Get document symbols from LSP
      let symbols: (LSPDocumentSymbol | any)[] = [];
      try {
        symbols = await this.client.documentSymbols(uri);
      } catch {
        // Fall back to regex for this file
        results.push(await parseTerraformFile(filePath));
        continue;
      }

      // Convert LSP symbols to our format
      const result = this.convertSymbolsToResult(filePath, content, symbols);
      results.push(result);

      this.client.closeDocument(uri);
    }

    return results;
  }

  /**
   * Convert LSP document symbols to TerraformParseResult
   */
  private convertSymbolsToResult(
    filePath: string,
    content: string,
    symbols: (LSPDocumentSymbol | any)[]
  ): TerraformParseResult {
    const result: TerraformParseResult = {
      file: filePath,
      resources: [],
      modules: [],
      variables: [],
      outputs: [],
      providers: [],
      dataSources: [],
      locals: {},
      errors: [],
    };

    const lines = content.split('\n');

    for (const sym of symbols) {
      const line = (sym.range?.start?.line ?? sym.location?.range?.start?.line ?? 0) + 1;
      const name = sym.name;

      // terraform-ls uses specific symbol kinds and naming patterns
      // Symbol name format: "resource.aws_instance.web" or "variable.my_var"
      if (name.startsWith('resource.')) {
        const parts = name.replace('resource.', '').split('.');
        if (parts.length >= 2) {
          const [type, resourceName] = parts;
          const blockContent = this.extractBlockAtLine(lines, line - 1);
          result.resources.push({
            type,
            name: resourceName,
            provider: type.split('_')[0],
            file: filePath,
            line,
            dependencies: extractDependsOn(blockContent),
            references: extractReferences(blockContent),
          });
        }
      } else if (name.startsWith('data.')) {
        const parts = name.replace('data.', '').split('.');
        if (parts.length >= 2) {
          const [type, dataName] = parts;
          const blockContent = this.extractBlockAtLine(lines, line - 1);
          result.dataSources.push({
            type,
            name: dataName,
            provider: type.split('_')[0],
            file: filePath,
            line,
            references: extractReferences(blockContent),
          });
        }
      } else if (name.startsWith('module.')) {
        const moduleName = name.replace('module.', '');
        const blockContent = this.extractBlockAtLine(lines, line - 1);
        result.modules.push({
          name: moduleName,
          source: extractAttribute(blockContent, 'source'),
          file: filePath,
          line,
          variables: extractVariableMappings(blockContent),
        });
      } else if (name.startsWith('variable.')) {
        const varName = name.replace('variable.', '');
        const blockContent = this.extractBlockAtLine(lines, line - 1);
        result.variables.push({
          name: varName,
          type: extractAttribute(blockContent, 'type') || undefined,
          default: extractAttribute(blockContent, 'default') || undefined,
          description: extractAttribute(blockContent, 'description') || undefined,
          file: filePath,
          line,
        });
      } else if (name.startsWith('output.')) {
        const outputName = name.replace('output.', '');
        const blockContent = this.extractBlockAtLine(lines, line - 1);
        result.outputs.push({
          name: outputName,
          value: extractAttribute(blockContent, 'value'),
          description: extractAttribute(blockContent, 'description') || undefined,
          file: filePath,
          line,
          references: extractReferences(blockContent),
        });
      } else if (name.startsWith('provider.')) {
        const providerName = name.replace('provider.', '').split('.')[0];
        const blockContent = this.extractBlockAtLine(lines, line - 1);
        result.providers.push({
          name: providerName,
          alias: extractAttribute(blockContent, 'alias') || undefined,
          file: filePath,
          line,
        });
      } else if (name.startsWith('locals')) {
        const blockContent = this.extractBlockAtLine(lines, line - 1);
        const localVars = extractLocalVariables(blockContent);
        Object.assign(result.locals, localVars);
      }
    }

    return result;
  }

  /**
   * Extract a block starting at the given line index
   */
  private extractBlockAtLine(lines: string[], startIndex: number): string {
    return extractBlock(lines, startIndex);
  }
}

/**
 * Parse Terraform directory using terraform-ls if available, regex fallback otherwise
 */
export async function parseTerraformDirectoryWithLSP(
  dirPath: string,
  options?: ParseOptions
): Promise<{ results: TerraformParseResult[]; method: 'lsp' | 'regex' }> {
  const useLSP = await isTerraformLSAvailable();

  if (useLSP) {
    if (options?.verbose) {
      console.log('[terraform-ls] Language server available, using LSP extraction');
    }

    const extractor = new TerraformLSPExtractor(dirPath);
    try {
      await extractor.start();
      const results = await extractor.extract();
      await extractor.stop();

      if (options?.verbose) {
        const totalResources = results.reduce((sum, r) => sum + r.resources.length, 0);
        const totalModules = results.reduce((sum, r) => sum + r.modules.length, 0);
        console.log(`[terraform-ls] Parsed ${totalResources} resources, ${totalModules} modules`);
      }

      return { results, method: 'lsp' };
    } catch (err) {
      if (options?.verbose) {
        console.log(`[terraform-ls] LSP failed: ${err instanceof Error ? err.message : err}`);
        console.log('[terraform-ls] Falling back to regex parsing');
      }
      await extractor.stop().catch(() => {});
    }
  } else {
    if (options?.verbose) {
      console.log('[terraform] terraform-ls not found, using regex parsing');
      console.log('[terraform] Install terraform-ls for better accuracy: brew install hashicorp/tap/terraform-ls');
    }
  }

  // Fallback to regex parsing
  const results = await parseTerraformDirectory(dirPath, options);
  return { results, method: 'regex' };
}
