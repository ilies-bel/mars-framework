/**
 * Python AST Parser using Tree-sitter
 *
 * This module provides parsing capabilities for Python source files,
 * extracting symbols (functions, classes, methods), imports, and references.
 */

import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import * as fs from 'fs';
import * as path from 'path';
import type {
  ParseResult,
  SymbolInfo,
  Reference,
  Import,
  ImportedSymbol,
  SymbolKind,
  ReferenceKind,
  ParseOptions,
} from '../types.js';
// Framework pattern matching removed for simplification

// Initialize tree-sitter parser
const parser = new Parser();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
parser.setLanguage(Python as any);

/**
 * Parse a single Python file and extract symbols, references, and imports
 *
 * @param filePath - Absolute path to the Python file
 * @returns ParseResult containing all extracted information
 */
export async function parsePythonFile(filePath: string): Promise<ParseResult> {
  const errors: string[] = [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      file: filePath,
      language: 'python',
      symbols: [],
      references: [],
      imports: [],
      errors: [`Failed to read file: ${err}`],
    };
  }

  let tree: Parser.Tree;
  try {
    tree = parser.parse(content);
  } catch (err) {
    return {
      file: filePath,
      language: 'python',
      symbols: [],
      references: [],
      imports: [],
      errors: [`Failed to parse file: ${err}`],
    };
  }

  const symbols: SymbolInfo[] = [];
  const references: Reference[] = [];
  const imports: Import[] = [];

  // Walk the AST
  walkTree(tree.rootNode, filePath, content, symbols, references, imports, null);

  return {
    file: filePath,
    language: 'python',
    symbols,
    references,
    imports,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Context for tracking the current class scope during AST traversal
 */
interface ClassContext {
  name: string;
  node: Parser.SyntaxNode;
}

/**
 * Recursively walk the AST and extract symbols, references, and imports
 */
function walkTree(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  symbols: SymbolInfo[],
  references: Reference[],
  imports: Import[],
  classContext: ClassContext | null
): void {
  switch (node.type) {
    case 'function_definition':
    case 'async_function_definition':
      handleFunctionDefinition(node, filePath, content, symbols, references, classContext);
      // Continue walking for nested definitions and calls
      walkChildren(node, filePath, content, symbols, references, imports, classContext);
      break;

    case 'class_definition':
      handleClassDefinition(node, filePath, content, symbols, references, imports);
      break;

    case 'import_statement':
      handleImportStatement(node, imports);
      break;

    case 'import_from_statement':
      handleImportFromStatement(node, imports);
      break;

    case 'call':
      handleCall(node, filePath, content, references, imports, classContext);
      // Continue walking for nested calls
      walkChildren(node, filePath, content, symbols, references, imports, classContext);
      break;

    default:
      // Continue walking children
      walkChildren(node, filePath, content, symbols, references, imports, classContext);
      break;
  }
}

/**
 * Walk all children of a node
 */
function walkChildren(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  symbols: SymbolInfo[],
  references: Reference[],
  imports: Import[],
  classContext: ClassContext | null
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      walkTree(child, filePath, content, symbols, references, imports, classContext);
    }
  }
}

/**
 * Handle function definition (def or async def)
 */
function handleFunctionDefinition(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  symbols: SymbolInfo[],
  references: Reference[],
  classContext: ClassContext | null
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const name = nameNode.text;
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  // Determine if this is a method (inside a class) or a function
  const kind: SymbolKind = classContext ? 'method' : 'function';

  // Build the full name for methods (ClassName.method_name)
  const fullName = classContext ? `${classContext.name}.${name}` : name;

  const signature = extractSignature(node, content);
  const docstring = extractDocstring(node);
  const exported = isExported(node, name);

  symbols.push({
    id: generateSymbolId(filePath, fullName, line),
    name: fullName,
    kind,
    file: filePath,
    line,
    endLine,
    exported,
    signature,
    docstring,
  });

  // Extract framework dependency injection references from function parameters
  const frameworkRefs = extractFrameworkReferences(node, filePath, content);
  references.push(...frameworkRefs);
}

/**
 * Handle class definition
 */
function handleClassDefinition(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  symbols: SymbolInfo[],
  references: Reference[],
  imports: Import[]
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const name = nameNode.text;
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const signature = extractClassSignature(node);
  const docstring = extractDocstring(node);
  const exported = isExported(node, name);

  symbols.push({
    id: generateSymbolId(filePath, name, line),
    name,
    kind: 'class',
    file: filePath,
    line,
    endLine,
    exported,
    signature,
    docstring,
  });

  // Create class context for methods
  const classContext: ClassContext = { name, node };

  // Walk the class body to find methods
  const bodyNode = node.childForFieldName('body');
  if (bodyNode) {
    walkTree(bodyNode, filePath, content, symbols, references, imports, classContext);
  }
}

/**
 * Handle import statement: import module, import module as alias
 */
function handleImportStatement(node: Parser.SyntaxNode, imports: Import[]): void {
  const line = node.startPosition.row + 1;

  // Find all dotted_name or aliased_import children
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === 'dotted_name') {
      // Simple import: import module
      imports.push({
        source: child.text,
        symbols: [{ name: '*' }],
        line,
      });
    } else if (child.type === 'aliased_import') {
      // Import with alias: import module as alias
      const nameNode = child.childForFieldName('name');
      const aliasNode = child.childForFieldName('alias');

      if (nameNode) {
        imports.push({
          source: nameNode.text,
          symbols: [{ name: '*' }],
          moduleAlias: aliasNode?.text,
          line,
        });
      }
    }
  }
}

/**
 * Handle from-import statement: from module import symbol, from . import relative
 */
function handleImportFromStatement(node: Parser.SyntaxNode, imports: Import[]): void {
  const line = node.startPosition.row + 1;

  // Get the module name
  const moduleNode = node.childForFieldName('module_name');
  let moduleName = '';

  // Handle relative imports (from . import or from .. import)
  // Check for relative_import node or leading dots
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === 'relative_import') {
      // Handle relative_import node
      const dotsNode = child.childForFieldName('dots');
      const nameNode = child.childForFieldName('name');
      moduleName = (dotsNode?.text || '') + (nameNode?.text || '');
      break;
    }

    // Handle dots followed by dotted_name
    if (child.text === '.' || child.text === '..') {
      moduleName += child.text;
    } else if (child.type === 'dotted_name' && moduleName.startsWith('.')) {
      moduleName += child.text;
      break;
    }
  }

  // If no relative import was found, use module_name
  if (!moduleName && moduleNode) {
    moduleName = moduleNode.text;
  }

  // Find imported symbols with their aliases
  const importedSymbols: ImportedSymbol[] = [];
  let isWildcard = false;

  // Look for import list or wildcard
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === 'wildcard_import' || child.text === '*') {
      // Wildcard import: from module import *
      isWildcard = true;
      importedSymbols.push({ name: '*' });
    } else if (child.type === 'dotted_name' && !moduleName.includes(child.text)) {
      // Simple import: from module import name
      importedSymbols.push({ name: child.text });
    } else if (child.type === 'aliased_import') {
      // Import with alias: from module import name as alias
      const nameNode = child.childForFieldName('name');
      const aliasNode = child.childForFieldName('alias');
      if (nameNode) {
        importedSymbols.push({
          name: nameNode.text,
          alias: aliasNode?.text,
        });
      }
    } else if (child.type === 'import_list') {
      // Multiple imports: from module import a, b, c or from module import a as x, b as y
      for (let j = 0; j < child.childCount; j++) {
        const importChild = child.child(j);
        if (!importChild) continue;

        if (importChild.type === 'dotted_name') {
          importedSymbols.push({ name: importChild.text });
        } else if (importChild.type === 'aliased_import') {
          const nameNode = importChild.childForFieldName('name');
          const aliasNode = importChild.childForFieldName('alias');
          if (nameNode) {
            importedSymbols.push({
              name: nameNode.text,
              alias: aliasNode?.text,
            });
          }
        }
      }
    }
  }

  if (moduleName || importedSymbols.length > 0) {
    imports.push({
      source: moduleName || '.',
      symbols: importedSymbols.length > 0 ? importedSymbols : [{ name: '*' }],
      isWildcard,
      line,
    });
  }
}

/**
 * Resolve an alias to its original symbol name using imports
 * Returns an object with the resolved name and optionally the full module path
 *
 * Handles three types of aliases:
 * 1. Per-symbol alias: `from X import Y as Z` - Z resolves to Y with module X
 * 2. Module-level alias: `import X as Y` - Y resolves to X (as module path)
 * 3. Submodule import: `from X import Y` - Y.func() resolves to X.Y.func
 *    This is common in Django (from views import auth_views -> auth_views.LoginView)
 */
function resolveAlias(
  name: string,
  imports: Import[]
): { resolvedName: string; modulePath?: string; isModuleAlias?: boolean } {
  for (const imp of imports) {
    // Check for per-symbol aliases first: `from X import Y as Z`
    for (const sym of imp.symbols) {
      if (sym.alias === name) {
        // Return the original name and the module path for full resolution
        return {
          resolvedName: sym.name,
          modulePath: imp.source,
        };
      }
    }

    // Check for module-level aliases: `import X as Y`
    if (imp.moduleAlias === name) {
      return {
        resolvedName: imp.source,
        modulePath: imp.source,
        isModuleAlias: true,
      };
    }

    // Check for submodule imports: `from X import Y` where Y is used as Y.func()
    // This handles cases like:
    //   from django.views import auth_views -> auth_views.LoginView()
    //   from django.utils.translation import gettext_lazy as _ -> _("string")
    // We treat the imported symbol as a potential module alias
    for (const sym of imp.symbols) {
      // Only match if the symbol has no alias (otherwise it was already handled above)
      // and the name matches the symbol name
      if (!sym.alias && sym.name === name && sym.name !== '*') {
        // Treat this as a module alias: from X import Y means Y -> X.Y
        return {
          resolvedName: `${imp.source}.${sym.name}`,
          modulePath: `${imp.source}.${sym.name}`,
          isModuleAlias: true,
        };
      }
    }
  }
  // Not an alias, return the name as-is
  return { resolvedName: name };
}

/**
 * Handle function/method calls
 */
function handleCall(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  references: Reference[],
  imports: Import[],
  classContext: ClassContext | null
): void {
  const functionNode = node.childForFieldName('function');
  if (!functionNode) return;

  const line = node.startPosition.row + 1;
  let symbolId: string;
  const kind: ReferenceKind = 'call';
  let methodName: string | null = null; // Track method name for unresolved method calls

  if (functionNode.type === 'identifier') {
    // Simple function call: func() or AliasedClass()
    const callName = functionNode.text;

    // Check if this is an aliased import and resolve to original name
    // We only use the resolved name (not the full module path) so that
    // the structure analyzer can properly match it against imports and
    // resolve to actual symbol IDs in the index.
    //
    // Example: from fastapi.openapi.models import OAuthFlows as OAuthFlowsModel
    //          OAuthFlowsModel() -> symbolId = "OAuthFlows"
    // The structure analyzer will then match "OAuthFlows" against the import
    // and resolve it to the actual symbol ID.
    const { resolvedName } = resolveAlias(callName, imports);
    symbolId = resolvedName;
  } else if (functionNode.type === 'attribute') {
    // Method call: obj.method() or module.func()
    // Check if this is self.method() or cls.method() within a class
    const objectNode = functionNode.childForFieldName('object');
    const attrNode = functionNode.childForFieldName('attribute');

    if (objectNode && attrNode && classContext) {
      const objectText = objectNode.text;
      methodName = attrNode.text;
      // Resolve self.method() or cls.method() to ClassName.method
      if (objectText === 'self' || objectText === 'cls') {
        symbolId = `${classContext.name}.${attrNode.text}`;
        methodName = null; // Fully resolved, no need for method-only reference
      } else if (objectText === 'super()') {
        // super().method() - resolve to ClassName.method (parent will be handled by find-callers)
        symbolId = `${classContext.name}.${attrNode.text}`;
        // Keep methodName for super() calls since we want to find parent class methods too
      } else {
        // Check if the object is an aliased import
        const { resolvedName, isModuleAlias, modulePath } = resolveAlias(objectText, imports);
        if (resolvedName !== objectText) {
          if (isModuleAlias) {
            // Module alias (import numpy as np): np.array -> numpy.array
            // Use full module path for the structure analyzer to match
            symbolId = `${resolvedName}.${attrNode.text}`;
            methodName = null; // Resolved via module alias
          } else if (modulePath) {
            // Per-symbol alias with module path (from X import Y as Z): Z.method -> X.Y.method
            // Use full module path + resolved name + attribute for proper resolution
            // Example: from django.contrib.auth import views as auth_views
            //          auth_views.LoginView -> django.contrib.auth.views.LoginView
            symbolId = `${modulePath}.${resolvedName}.${attrNode.text}`;
            methodName = null; // Resolved via symbol alias with full path
          } else {
            // Per-symbol alias without module path (fallback)
            symbolId = `${resolvedName}.${attrNode.text}`;
            methodName = null; // Resolved via symbol alias
          }
        } else {
          symbolId = functionNode.text;
          // Keep methodName for unresolved instance.method() calls
        }
      }
    } else if (objectNode && attrNode) {
      methodName = attrNode.text;
      // Check if the object is an aliased import (outside class context)
      const objectText = objectNode.text;
      const { resolvedName, isModuleAlias, modulePath } = resolveAlias(objectText, imports);
      if (resolvedName !== objectText) {
        if (isModuleAlias) {
          // Module alias (import numpy as np): np.array -> numpy.array
          symbolId = `${resolvedName}.${attrNode.text}`;
          methodName = null; // Resolved via module alias
        } else if (modulePath) {
          // Per-symbol alias with module path (from X import Y as Z): Z.method -> X.Y.method
          // Use full module path + resolved name + attribute for proper resolution
          // Example: from django.contrib.auth import views as auth_views
          //          auth_views.LoginView -> django.contrib.auth.views.LoginView
          symbolId = `${modulePath}.${resolvedName}.${attrNode.text}`;
          methodName = null; // Resolved via symbol alias with full path
        } else {
          // Per-symbol alias without module path (fallback)
          symbolId = `${resolvedName}.${attrNode.text}`;
          methodName = null; // Resolved via symbol alias
        }
      } else {
        symbolId = functionNode.text;
        // Keep methodName for unresolved instance.method() calls
      }
    } else {
      symbolId = functionNode.text;
    }
  } else {
    // Other complex expressions (e.g., func()(), getattr()())
    symbolId = functionNode.text;
  }

  references.push({
    symbolId,
    file: filePath,
    line,
    kind,
  });

  // For unresolved method calls (instance.method() where we don't know the type),
  // also add a method-only reference so find_callers can match by method name.
  // This enables finding callers like admin.get_queryset() when searching for ModelAdmin.get_queryset
  if (methodName) {
    references.push({
      symbolId: `*.${methodName}`,
      file: filePath,
      line,
      kind,
    });
  }

  // Extract callback references from arguments
  // This captures patterns like: add_api_route("/path", endpoint=my_handler)
  // or request_response(serialize_response)
  const callbackRefs = extractCallbackReferences(node, filePath, imports);
  references.push(...callbackRefs);
}

/**
 * Extract callback references from function call arguments
 * Captures functions passed as arguments (not being called)
 * e.g., add_api_route("/path", endpoint=my_handler) -> my_handler is a callback
 */
function extractCallbackReferences(
  callNode: Parser.SyntaxNode,
  filePath: string,
  imports: Import[]
): Reference[] {
  const references: Reference[] = [];

  // Get the arguments node
  const argsNode = callNode.childForFieldName('arguments');
  if (!argsNode) return references;

  // Process each argument
  for (let i = 0; i < argsNode.childCount; i++) {
    const arg = argsNode.child(i);
    if (!arg) continue;

    // Skip non-meaningful nodes (commas, parentheses)
    if (arg.type === ',' || arg.type === '(' || arg.type === ')') continue;

    // Handle keyword arguments: param=value
    if (arg.type === 'keyword_argument') {
      const valueNode = arg.childForFieldName('value');
      if (valueNode) {
        const callbackRef = extractCallbackFromNode(valueNode, filePath, imports);
        if (callbackRef) {
          references.push(callbackRef);
        }
      }
    }
    // Handle positional arguments
    else if (arg.type === 'identifier' || arg.type === 'attribute') {
      const callbackRef = extractCallbackFromNode(arg, filePath, imports);
      if (callbackRef) {
        references.push(callbackRef);
      }
    }
  }

  return references;
}

/**
 * Extract a callback reference from an identifier or attribute node
 * Returns null if the node doesn't look like a function reference
 */
function extractCallbackFromNode(
  node: Parser.SyntaxNode,
  filePath: string,
  imports: Import[]
): Reference | null {
  const line = node.startPosition.row + 1;
  let symbolId: string;

  if (node.type === 'identifier') {
    const name = node.text;

    // Skip common non-function values (strings, numbers, None, True, False)
    if (name === 'None' || name === 'True' || name === 'False') {
      return null;
    }
    // Skip if it looks like a constant (all uppercase)
    if (name === name.toUpperCase() && name.length > 1) {
      return null;
    }

    // Check if this is an aliased import and resolve to original name
    const { resolvedName } = resolveAlias(name, imports);
    symbolId = resolvedName;
  } else if (node.type === 'attribute') {
    // Handle module.function or object.method
    const objectNode = node.childForFieldName('object');
    const attrNode = node.childForFieldName('attribute');

    if (objectNode && attrNode) {
      const objectText = objectNode.text;
      const { resolvedName: resolvedObjName, modulePath, isModuleAlias } = resolveAlias(objectText, imports);

      if (resolvedObjName !== objectText && modulePath) {
        if (isModuleAlias) {
          // Module alias (import numpy as np): np.array -> numpy.array
          symbolId = `${resolvedObjName}.${attrNode.text}`;
        } else {
          // Per-symbol alias (from X import Y as Z): Z.attr -> X.Y.attr
          // Example: from django.contrib.auth import views as auth_views
          //          auth_views.LoginView -> django.contrib.auth.views.LoginView
          symbolId = `${modulePath}.${resolvedObjName}.${attrNode.text}`;
        }
      } else {
        symbolId = node.text;
      }
    } else {
      symbolId = node.text;
    }
  } else {
    // Not an identifier or attribute, skip
    return null;
  }

  return {
    symbolId,
    file: filePath,
    line,
    kind: 'callback',
  };
}

/**
 * Extract framework dependency injection references from function parameters
 * Simplified: returns empty array (framework patterns removed for MVP)
 */
function extractFrameworkReferences(
  _node: Parser.SyntaxNode,
  _filePath: string,
  _content: string
): Reference[] {
  // Framework pattern matching removed for simplification
  return [];
}

/**
 * Extract function signature from a function definition node
 */
function extractSignature(node: Parser.SyntaxNode, content: string): string {
  const nameNode = node.childForFieldName('name');
  const paramsNode = node.childForFieldName('parameters');
  const returnTypeNode = node.childForFieldName('return_type');

  if (!nameNode) return '';

  let signature = node.type === 'async_function_definition' ? 'async def ' : 'def ';
  signature += nameNode.text;

  if (paramsNode) {
    signature += paramsNode.text;
  } else {
    signature += '()';
  }

  if (returnTypeNode) {
    signature += ' -> ' + returnTypeNode.text;
  }

  return signature;
}

/**
 * Extract class signature (name and base classes)
 */
function extractClassSignature(node: Parser.SyntaxNode): string {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return '';

  let signature = 'class ' + nameNode.text;

  // Look for argument_list (base classes)
  const superclassNode = node.childForFieldName('superclasses');
  if (superclassNode) {
    signature += superclassNode.text;
  }

  return signature;
}

/**
 * Extract docstring from a function or class definition
 * Docstrings are string literals as the first statement in the body
 */
function extractDocstring(node: Parser.SyntaxNode): string | undefined {
  const bodyNode = node.childForFieldName('body');
  if (!bodyNode) return undefined;

  // The body is typically a block node, look for first child
  const firstChild = bodyNode.child(0);
  if (!firstChild) return undefined;

  // Check if first statement is an expression statement containing a string
  if (firstChild.type === 'expression_statement') {
    const exprChild = firstChild.child(0);
    if (exprChild && exprChild.type === 'string') {
      return cleanDocstring(exprChild.text);
    }
  }

  return undefined;
}

/**
 * Clean up a docstring by removing quotes and normalizing whitespace
 */
function cleanDocstring(raw: string): string {
  // Remove triple quotes (""" or ''') or single quotes
  let cleaned = raw;

  if (cleaned.startsWith('"""') && cleaned.endsWith('"""')) {
    cleaned = cleaned.slice(3, -3);
  } else if (cleaned.startsWith("'''") && cleaned.endsWith("'''")) {
    cleaned = cleaned.slice(3, -3);
  } else if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1);
  } else if (cleaned.startsWith("'") && cleaned.endsWith("'")) {
    cleaned = cleaned.slice(1, -1);
  }

  // Trim and normalize whitespace
  return cleaned.trim();
}

/**
 * Determine if a symbol is exported (public API)
 * In Python, symbols are considered exported if:
 * - They are at module level (not nested)
 * - They don't start with underscore (_)
 */
function isExported(node: Parser.SyntaxNode, name: string): boolean {
  // Private symbols start with underscore
  if (name.startsWith('_')) {
    return false;
  }

  // Check if at module level (parent is module or decorated_definition at module level)
  const parent = node.parent;
  if (!parent) return true;

  if (parent.type === 'module') {
    return true;
  }

  // Handle decorated definitions
  if (parent.type === 'decorated_definition') {
    const grandparent = parent.parent;
    return grandparent?.type === 'module';
  }

  // Nested functions/classes are not exported
  return false;
}

/**
 * Generate a unique symbol ID
 */
function generateSymbolId(filePath: string, name: string, line: number): string {
  return `${filePath}:${name}:${line}`;
}

/**
 * Append a parse error to the error log file
 */
function logParseError(errorLogPath: string, filePath: string, errorMessage: string): void {
  try {
    fs.appendFileSync(errorLogPath, `${filePath}: ${errorMessage}\n`);
  } catch {
    // Silently ignore errors writing to the log file
  }
}

/**
 * Parse all Python files in a directory recursively
 *
 * @param dirPath - Path to the directory to parse
 * @param options - Optional parse options for error logging and verbose mode
 * @returns Array of ParseResult for each Python file
 */
export async function parsePythonDirectory(
  dirPath: string,
  options?: ParseOptions
): Promise<ParseResult[]> {
  const results: ParseResult[] = [];
  const pythonFiles = findPythonFiles(dirPath);
  const totalFiles = pythonFiles.length;

  // Clear the error log file if it exists and options specify a path
  if (options?.errorLogPath) {
    try {
      fs.writeFileSync(options.errorLogPath, '');
    } catch {
      // Silently ignore errors clearing the log file
    }
  }

  for (let i = 0; i < pythonFiles.length; i++) {
    const filePath = pythonFiles[i];

    // Verbose progress logging every 100 files
    if (options?.verbose && (i + 1) % 100 === 0) {
      console.log(`Parsed ${i + 1}/${totalFiles} Python files...`);
    }

    const result = await parsePythonFile(filePath);
    results.push(result);

    // Log errors if error log path is specified or verbose mode is enabled
    if (result.errors && result.errors.length > 0) {
      const errorMessage = result.errors.join('; ');

      if (options?.verbose) {
        console.log(`Failed to parse: ${filePath}: ${errorMessage}`);
      }

      if (options?.errorLogPath) {
        logParseError(options.errorLogPath, filePath, errorMessage);
      }
    }
  }

  // Final progress log in verbose mode
  if (options?.verbose) {
    console.log(`Completed parsing ${totalFiles} Python files.`);
  }

  return results;
}

/**
 * Recursively find all Python files in a directory
 */
function findPythonFiles(dirPath: string): string[] {
  const files: string[] = [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Skip hidden directories and common non-source directories
        if (
          !entry.name.startsWith('.') &&
          entry.name !== 'node_modules' &&
          entry.name !== '__pycache__' &&
          entry.name !== 'venv' &&
          entry.name !== '.venv' &&
          entry.name !== 'env' &&
          entry.name !== '.env'
        ) {
          files.push(...findPythonFiles(fullPath));
        }
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        files.push(fullPath);
      }
    }
  } catch (err) {
    // Silently skip directories we can't read
  }

  return files;
}

/**
 * Check if a file is a Python file
 */
export function isPythonFile(filePath: string): boolean {
  return filePath.endsWith('.py');
}

/**
 * Get the module name from a file path
 * e.g., /path/to/project/src/module/file.py -> src.module.file
 */
export function getModuleName(filePath: string, rootPath: string): string {
  const relativePath = path.relative(rootPath, filePath);
  const withoutExt = relativePath.replace(/\.py$/, '');
  const moduleName = withoutExt.replace(/\//g, '.').replace(/\\/g, '.');

  // Handle __init__.py files
  if (moduleName.endsWith('.__init__')) {
    return moduleName.slice(0, -9);
  }

  return moduleName;
}
