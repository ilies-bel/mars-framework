/**
 * TypeScript/JavaScript AST Parser using Tree-sitter
 *
 * This module provides parsing capabilities for TypeScript and JavaScript source files,
 * extracting symbols (functions, classes, methods, interfaces, React components),
 * imports, and references.
 */

import Parser from 'tree-sitter';
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

// Lazy-loaded TypeScript/TSX language grammars
let TypeScript: unknown;
let TSX: unknown;

/**
 * Dynamically load the tree-sitter-typescript module
 */
async function loadTypeScriptGrammar(): Promise<void> {
  if (!TypeScript || !TSX) {
    const tsModule = await import('tree-sitter-typescript');
    TypeScript = tsModule.default?.typescript || tsModule.typescript;
    TSX = tsModule.default?.tsx || tsModule.tsx;
  }
}

// Parser instances (initialized lazily)
let tsParser: Parser | null = null;
let tsxParser: Parser | null = null;

/**
 * Get or initialize the TypeScript parser
 */
async function getParser(isTSX: boolean): Promise<Parser> {
  await loadTypeScriptGrammar();

  if (isTSX) {
    if (!tsxParser) {
      tsxParser = new Parser();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tsxParser.setLanguage(TSX as any);
    }
    return tsxParser;
  } else {
    if (!tsParser) {
      tsParser = new Parser();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tsParser.setLanguage(TypeScript as any);
    }
    return tsParser;
  }
}

/**
 * Determine if a file should use TSX parser based on extension
 */
function isTSXFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.tsx' || ext === '.jsx';
}

/**
 * Check if a file is a TypeScript or JavaScript file
 */
export function isTypeScriptFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.ts', '.tsx', '.js', '.jsx'].includes(ext);
}

/**
 * Parse a single TypeScript/JavaScript file and extract symbols, references, and imports
 *
 * @param filePath - Absolute path to the TypeScript/JavaScript file
 * @returns ParseResult containing all extracted information
 */
export async function parseTypeScriptFile(filePath: string): Promise<ParseResult> {
  const errors: string[] = [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      file: filePath,
      language: 'typescript',
      symbols: [],
      references: [],
      imports: [],
      errors: [`Failed to read file: ${err}`],
    };
  }

  let parser: Parser;
  try {
    parser = await getParser(isTSXFile(filePath));
  } catch (err) {
    return {
      file: filePath,
      language: 'typescript',
      symbols: [],
      references: [],
      imports: [],
      errors: [`Failed to load TypeScript grammar: ${err}`],
    };
  }

  let tree: Parser.Tree;
  try {
    tree = parser.parse(content);
  } catch (err) {
    return {
      file: filePath,
      language: 'typescript',
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
    language: 'typescript',
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
    case 'function_declaration':
    case 'generator_function_declaration':
      handleFunctionDeclaration(node, filePath, content, symbols, classContext);
      walkChildren(node, filePath, content, symbols, references, imports, classContext);
      break;

    case 'class_declaration':
      handleClassDeclaration(node, filePath, content, symbols, references, imports);
      break;

    case 'interface_declaration':
      handleInterfaceDeclaration(node, filePath, content, symbols);
      walkChildren(node, filePath, content, symbols, references, imports, classContext);
      break;

    case 'type_alias_declaration':
      handleTypeAliasDeclaration(node, filePath, content, symbols);
      walkChildren(node, filePath, content, symbols, references, imports, classContext);
      break;

    case 'method_definition':
      handleMethodDefinition(node, filePath, content, symbols, classContext);
      walkChildren(node, filePath, content, symbols, references, imports, classContext);
      break;

    case 'lexical_declaration':
    case 'variable_declaration':
      handleVariableDeclaration(node, filePath, content, symbols, references, imports, classContext);
      break;

    case 'import_statement':
      handleImportStatement(node, imports);
      break;

    case 'export_statement':
      handleExportStatement(node, filePath, content, symbols, references, imports, classContext);
      break;

    case 'call_expression':
      handleCallExpression(node, filePath, content, references);
      walkChildren(node, filePath, content, symbols, references, imports, classContext);
      break;

    default:
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
 * Check if a node represents a React component (returns JSX)
 */
export function isReactComponent(node: Parser.SyntaxNode): boolean {
  // Look for JSX elements in the function body or return statement
  const body = node.childForFieldName('body');
  if (!body) return false;

  return containsJSX(body);
}

/**
 * Recursively check if a node contains JSX elements
 */
function containsJSX(node: Parser.SyntaxNode): boolean {
  if (
    node.type === 'jsx_element' ||
    node.type === 'jsx_self_closing_element' ||
    node.type === 'jsx_fragment'
  ) {
    return true;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && containsJSX(child)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a function name indicates it's a React hook
 */
function isReactHook(name: string): boolean {
  return name.startsWith('use') && name.length > 3 && name[3] === name[3].toUpperCase();
}

/**
 * Extract a React component symbol
 */
export function extractReactComponent(
  node: Parser.SyntaxNode,
  filePath: string,
  name: string,
  content: string
): SymbolInfo {
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const signature = extractFunctionSignature(node, content);
  const docstring = extractJSDocComment(node);
  const exported = isExported(node);

  return {
    id: generateSymbolId(filePath, name, line),
    name,
    kind: 'function', // React components are functions
    file: filePath,
    line,
    endLine,
    exported,
    signature: `// React Component\n${signature}`,
    docstring,
  };
}

/**
 * Extract a function symbol
 */
export function extractFunction(
  node: Parser.SyntaxNode,
  filePath: string,
  name: string,
  content: string,
  classContext: ClassContext | null
): SymbolInfo {
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const kind: SymbolKind = classContext ? 'method' : 'function';
  const fullName = classContext ? `${classContext.name}.${name}` : name;

  const signature = extractFunctionSignature(node, content);
  const docstring = extractJSDocComment(node);
  const exported = isExported(node);

  // Add hook indicator to signature if it's a React hook
  const signaturePrefix = isReactHook(name) ? '// React Hook\n' : '';

  return {
    id: generateSymbolId(filePath, fullName, line),
    name: fullName,
    kind,
    file: filePath,
    line,
    endLine,
    exported,
    signature: signaturePrefix + signature,
    docstring,
  };
}

/**
 * Extract a class symbol
 */
export function extractClass(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string
): SymbolInfo {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) {
    throw new Error('Class declaration without name');
  }

  const name = nameNode.text;
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const signature = extractClassSignature(node);
  const docstring = extractJSDocComment(node);
  const exported = isExported(node);

  return {
    id: generateSymbolId(filePath, name, line),
    name,
    kind: 'class',
    file: filePath,
    line,
    endLine,
    exported,
    signature,
    docstring,
  };
}

/**
 * Extract an import statement
 */
export function extractImport(node: Parser.SyntaxNode): Import | null {
  const line = node.startPosition.row + 1;

  // Find the source (module path)
  const sourceNode = node.childForFieldName('source');
  if (!sourceNode) return null;

  // Remove quotes from string literal
  const source = sourceNode.text.replace(/^['"]|['"]$/g, '');

  const symbols: ImportedSymbol[] = [];
  let moduleAlias: string | undefined;
  let isWildcard = false;

  // Process import clause
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    // import_clause contains default and named imports
    if (child.type === 'import_clause') {
      processImportClause(child, symbols, (alias) => {
        moduleAlias = alias;
      }, () => {
        isWildcard = true;
      });
    }
  }

  if (symbols.length === 0) {
    // Side-effect import: import 'module'
    symbols.push({ name: '*' });
    isWildcard = true;
  }

  return {
    source,
    symbols,
    moduleAlias,
    isWildcard,
    line,
  };
}

/**
 * Process an import clause to extract symbols
 */
function processImportClause(
  node: Parser.SyntaxNode,
  symbols: ImportedSymbol[],
  setModuleAlias: (alias: string) => void,
  setIsWildcard: () => void
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    // Default import: import X from 'module'
    if (child.type === 'identifier') {
      symbols.push({ name: 'default', alias: child.text });
      setModuleAlias(child.text);
    }

    // Namespace import: import * as X from 'module'
    if (child.type === 'namespace_import') {
      setIsWildcard();
      const aliasNode = child.childForFieldName('alias');
      if (aliasNode) {
        symbols.push({ name: '*', alias: aliasNode.text });
        setModuleAlias(aliasNode.text);
      } else {
        symbols.push({ name: '*' });
      }
    }

    // Named imports: import { a, b as c } from 'module'
    if (child.type === 'named_imports') {
      processNamedImports(child, symbols);
    }
  }
}

/**
 * Process named imports to extract symbols
 */
function processNamedImports(node: Parser.SyntaxNode, symbols: ImportedSymbol[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === 'import_specifier') {
      const nameNode = child.childForFieldName('name');
      const aliasNode = child.childForFieldName('alias');

      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          alias: aliasNode?.text,
        });
      }
    }
  }
}

/**
 * Extract calls/references from a function body
 */
export function extractCallsFromBody(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string
): Reference[] {
  const references: Reference[] = [];
  collectCalls(node, filePath, content, references);
  return references;
}

/**
 * Recursively collect call expressions
 */
function collectCalls(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  references: Reference[]
): void {
  if (node.type === 'call_expression') {
    const refs = createCallReferences(node, filePath, content);
    references.push(...refs);
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      collectCalls(child, filePath, content, references);
    }
  }
}

/**
 * Create a reference from a call expression
 * Returns an array of references - the primary reference and optionally a method-only reference
 */
function createCallReferences(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string
): Reference[] {
  const functionNode = node.childForFieldName('function');
  if (!functionNode) return [];

  const line = node.startPosition.row + 1;
  let symbolId: string;
  const kind: ReferenceKind = 'call';
  let methodName: string | null = null;

  if (functionNode.type === 'identifier') {
    symbolId = functionNode.text;
  } else if (functionNode.type === 'member_expression') {
    symbolId = functionNode.text;
    // For member expressions like obj.method(), extract the method name
    // for unresolved method call matching
    const propertyNode = functionNode.childForFieldName('property');
    const objectNode = functionNode.childForFieldName('object');
    if (propertyNode && objectNode) {
      const objectText = objectNode.text;
      // Skip if the object is 'this' (resolved to current class) or a known module import
      if (objectText !== 'this' && objectText !== 'super') {
        methodName = propertyNode.text;
      }
    }
  } else {
    symbolId = functionNode.text;
  }

  const references: Reference[] = [{
    symbolId,
    file: filePath,
    line,
    kind,
  }];

  // For unresolved method calls (instance.method() where we don't know the type),
  // also add a method-only reference so find_callers can match by method name.
  if (methodName) {
    references.push({
      symbolId: `*.${methodName}`,
      file: filePath,
      line,
      kind,
    });
  }

  return references;
}

/**
 * Create a reference from a call expression (legacy single reference for compatibility)
 */
function createCallReference(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string
): Reference | null {
  const refs = createCallReferences(node, filePath, content);
  return refs.length > 0 ? refs[0] : null;
}

/**
 * Handle function declaration
 */
function handleFunctionDeclaration(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  symbols: SymbolInfo[],
  classContext: ClassContext | null
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const name = nameNode.text;

  // Check if it's a React component
  if (isReactComponent(node)) {
    symbols.push(extractReactComponent(node, filePath, name, content));
  } else {
    symbols.push(extractFunction(node, filePath, name, content, classContext));
  }
}

/**
 * Handle class declaration
 */
function handleClassDeclaration(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  symbols: SymbolInfo[],
  references: Reference[],
  imports: Import[]
): void {
  try {
    symbols.push(extractClass(node, filePath, content));
  } catch {
    return;
  }

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const classContext: ClassContext = { name: nameNode.text, node };

  // Walk the class body to find methods
  const bodyNode = node.childForFieldName('body');
  if (bodyNode) {
    walkTree(bodyNode, filePath, content, symbols, references, imports, classContext);
  }
}

/**
 * Handle interface declaration
 */
function handleInterfaceDeclaration(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  symbols: SymbolInfo[]
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const name = nameNode.text;
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const signature = extractInterfaceSignature(node);
  const docstring = extractJSDocComment(node);
  const exported = isExported(node);

  symbols.push({
    id: generateSymbolId(filePath, name, line),
    name,
    kind: 'interface',
    file: filePath,
    line,
    endLine,
    exported,
    signature,
    docstring,
  });
}

/**
 * Handle type alias declaration
 */
function handleTypeAliasDeclaration(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  symbols: SymbolInfo[]
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const name = nameNode.text;
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const signature = `type ${name} = ...`;
  const docstring = extractJSDocComment(node);
  const exported = isExported(node);

  symbols.push({
    id: generateSymbolId(filePath, name, line),
    name,
    kind: 'type',
    file: filePath,
    line,
    endLine,
    exported,
    signature,
    docstring,
  });
}

/**
 * Handle method definition inside a class
 */
function handleMethodDefinition(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  symbols: SymbolInfo[],
  classContext: ClassContext | null
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const name = nameNode.text;
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const fullName = classContext ? `${classContext.name}.${name}` : name;
  const signature = extractMethodSignature(node, content);
  const docstring = extractJSDocComment(node);

  symbols.push({
    id: generateSymbolId(filePath, fullName, line),
    name: fullName,
    kind: 'method',
    file: filePath,
    line,
    endLine,
    exported: false, // Methods inherit export status from class
    signature,
    docstring,
  });
}

/**
 * Handle variable declaration (const, let, var)
 * This is where arrow functions and React.FC components are found
 */
function handleVariableDeclaration(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  symbols: SymbolInfo[],
  references: Reference[],
  imports: Import[],
  classContext: ClassContext | null
): void {
  // Find variable declarators
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.type !== 'variable_declarator') continue;

    const nameNode = child.childForFieldName('name');
    const valueNode = child.childForFieldName('value');

    if (!nameNode || !valueNode) continue;

    const name = nameNode.text;

    // Check if the value is an arrow function or function expression
    if (
      valueNode.type === 'arrow_function' ||
      valueNode.type === 'function' ||
      valueNode.type === 'function_expression'
    ) {
      // Check if it's a React component
      if (isReactComponent(valueNode)) {
        symbols.push(extractReactComponent(valueNode, filePath, name, content));
      } else {
        symbols.push(extractArrowFunction(child, filePath, name, content, classContext));
      }
    }
  }

  // Continue walking for nested calls
  walkChildren(node, filePath, content, symbols, references, imports, classContext);
}

/**
 * Extract arrow function symbol
 */
function extractArrowFunction(
  declaratorNode: Parser.SyntaxNode,
  filePath: string,
  name: string,
  content: string,
  classContext: ClassContext | null
): SymbolInfo {
  const valueNode = declaratorNode.childForFieldName('value');
  const line = declaratorNode.startPosition.row + 1;
  const endLine = declaratorNode.endPosition.row + 1;

  const kind: SymbolKind = classContext ? 'method' : 'function';
  const fullName = classContext ? `${classContext.name}.${name}` : name;

  const signature = extractArrowFunctionSignature(declaratorNode, content);
  const docstring = valueNode ? extractJSDocComment(valueNode) : undefined;
  const exported = isExported(declaratorNode);

  // Add hook indicator to signature if it's a React hook
  const signaturePrefix = isReactHook(name) ? '// React Hook\n' : '';

  return {
    id: generateSymbolId(filePath, fullName, line),
    name: fullName,
    kind,
    file: filePath,
    line,
    endLine,
    exported,
    signature: signaturePrefix + signature,
    docstring,
  };
}

/**
 * Handle import statement
 */
function handleImportStatement(node: Parser.SyntaxNode, imports: Import[]): void {
  const importInfo = extractImport(node);
  if (importInfo) {
    imports.push(importInfo);
  }
}

/**
 * Handle export statement
 */
function handleExportStatement(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  symbols: SymbolInfo[],
  references: Reference[],
  imports: Import[],
  classContext: ClassContext | null
): void {
  // Walk children to find the exported declaration
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    // Handle exported declarations
    if (
      child.type === 'function_declaration' ||
      child.type === 'class_declaration' ||
      child.type === 'interface_declaration' ||
      child.type === 'type_alias_declaration' ||
      child.type === 'lexical_declaration' ||
      child.type === 'variable_declaration'
    ) {
      walkTree(child, filePath, content, symbols, references, imports, classContext);
    }
  }
}

/**
 * Handle call expression
 */
function handleCallExpression(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  references: Reference[]
): void {
  const refs = createCallReferences(node, filePath, content);
  references.push(...refs);

  // Extract callback references from arguments
  // This captures patterns like: addEventListener("click", handleClick)
  // or array.map(transformItem)
  const callbackRefs = extractCallbackReferencesTS(node, filePath);
  references.push(...callbackRefs);
}

/**
 * Extract callback references from function call arguments
 * Captures functions passed as arguments (not being called)
 * e.g., addEventListener("click", handleClick) -> handleClick is a callback
 */
function extractCallbackReferencesTS(
  callNode: Parser.SyntaxNode,
  filePath: string
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

    // Handle identifiers or member expressions that could be function references
    if (arg.type === 'identifier') {
      const callbackRef = extractCallbackFromNodeTS(arg, filePath);
      if (callbackRef) {
        references.push(callbackRef);
      }
    } else if (arg.type === 'member_expression') {
      const callbackRef = extractCallbackFromNodeTS(arg, filePath);
      if (callbackRef) {
        references.push(callbackRef);
      }
    }
  }

  return references;
}

/**
 * Extract a callback reference from an identifier or member_expression node
 * Returns null if the node doesn't look like a function reference
 */
function extractCallbackFromNodeTS(
  node: Parser.SyntaxNode,
  filePath: string
): Reference | null {
  const line = node.startPosition.row + 1;
  let symbolId: string;

  if (node.type === 'identifier') {
    const name = node.text;

    // Skip common non-function values
    if (name === 'null' || name === 'undefined' || name === 'true' || name === 'false') {
      return null;
    }
    // Skip if it looks like a constant (all uppercase)
    if (name === name.toUpperCase() && name.length > 1) {
      return null;
    }

    symbolId = name;
  } else if (node.type === 'member_expression') {
    symbolId = node.text;
  } else {
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
 * Extract function signature
 */
function extractFunctionSignature(node: Parser.SyntaxNode, content: string): string {
  const nameNode = node.childForFieldName('name');
  const paramsNode = node.childForFieldName('parameters');
  const returnTypeNode = node.childForFieldName('return_type');

  let signature = '';

  // Check for async
  const isAsync = node.children.some((c) => c.type === 'async');
  if (isAsync) signature += 'async ';

  // Check for generator
  const isGenerator =
    node.type === 'generator_function_declaration' ||
    node.children.some((c) => c.text === '*');
  if (isGenerator) signature += 'function* ';
  else signature += 'function ';

  if (nameNode) {
    signature += nameNode.text;
  }

  if (paramsNode) {
    signature += paramsNode.text;
  } else {
    signature += '()';
  }

  if (returnTypeNode) {
    signature += ': ' + returnTypeNode.text;
  }

  return signature;
}

/**
 * Extract arrow function signature
 */
function extractArrowFunctionSignature(
  declaratorNode: Parser.SyntaxNode,
  content: string
): string {
  const nameNode = declaratorNode.childForFieldName('name');
  const valueNode = declaratorNode.childForFieldName('value');
  const typeNode = declaratorNode.childForFieldName('type');

  let signature = 'const ';

  if (nameNode) {
    signature += nameNode.text;
  }

  // Add type annotation if present (e.g., : React.FC<Props>)
  if (typeNode) {
    signature += ': ' + typeNode.text;
  }

  signature += ' = ';

  if (valueNode) {
    const paramsNode = valueNode.childForFieldName('parameters');
    const returnTypeNode = valueNode.childForFieldName('return_type');

    // Check for async
    const isAsync = valueNode.children.some((c) => c.type === 'async');
    if (isAsync) signature += 'async ';

    if (paramsNode) {
      signature += paramsNode.text;
    } else {
      // Arrow function with single parameter without parens
      const firstChild = valueNode.child(0);
      if (firstChild?.type === 'identifier') {
        signature += `(${firstChild.text})`;
      } else {
        signature += '()';
      }
    }

    if (returnTypeNode) {
      signature += ': ' + returnTypeNode.text;
    }

    signature += ' => ...';
  }

  return signature;
}

/**
 * Extract method signature
 */
function extractMethodSignature(node: Parser.SyntaxNode, content: string): string {
  const nameNode = node.childForFieldName('name');
  const paramsNode = node.childForFieldName('parameters');
  const returnTypeNode = node.childForFieldName('return_type');

  let signature = '';

  // Check for static, async, get, set modifiers
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'static') signature += 'static ';
    if (child?.type === 'async') signature += 'async ';
    if (child?.text === 'get') signature += 'get ';
    if (child?.text === 'set') signature += 'set ';
  }

  if (nameNode) {
    signature += nameNode.text;
  }

  if (paramsNode) {
    signature += paramsNode.text;
  } else {
    signature += '()';
  }

  if (returnTypeNode) {
    signature += ': ' + returnTypeNode.text;
  }

  return signature;
}

/**
 * Extract class signature
 */
function extractClassSignature(node: Parser.SyntaxNode): string {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return '';

  let signature = 'class ' + nameNode.text;

  // Look for type parameters
  const typeParamsNode = node.childForFieldName('type_parameters');
  if (typeParamsNode) {
    signature += typeParamsNode.text;
  }

  // Look for extends clause
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'class_heritage') {
      signature += ' ' + child.text;
      break;
    }
    // Handle extends_clause directly
    if (child?.type === 'extends_clause') {
      signature += ' extends ' + child.text;
    }
  }

  // Look for implements clause
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'implements_clause') {
      signature += ' implements ' + child.text;
    }
  }

  return signature;
}

/**
 * Extract interface signature
 */
function extractInterfaceSignature(node: Parser.SyntaxNode): string {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return '';

  let signature = 'interface ' + nameNode.text;

  // Look for type parameters
  const typeParamsNode = node.childForFieldName('type_parameters');
  if (typeParamsNode) {
    signature += typeParamsNode.text;
  }

  // Look for extends clause
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'extends_type_clause' || child?.type === 'extends_clause') {
      signature += ' extends ' + child.text;
    }
  }

  return signature;
}

/**
 * Extract JSDoc comment from a node
 */
function extractJSDocComment(node: Parser.SyntaxNode): string | undefined {
  // Look for preceding comment nodes
  let sibling = node.previousSibling;

  // Also check parent's previous sibling for exported declarations
  if (!sibling && node.parent) {
    sibling = node.parent.previousSibling;
  }

  while (sibling) {
    if (sibling.type === 'comment') {
      const text = sibling.text;
      // Check if it's a JSDoc comment
      if (text.startsWith('/**')) {
        return cleanJSDocComment(text);
      }
    }
    // Only check immediately preceding comments
    if (sibling.type !== 'comment') {
      break;
    }
    sibling = sibling.previousSibling;
  }

  return undefined;
}

/**
 * Clean up a JSDoc comment
 */
function cleanJSDocComment(raw: string): string {
  // Remove /** and */
  let cleaned = raw.replace(/^\/\*\*\s*/, '').replace(/\s*\*\/$/, '');

  // Remove leading * from each line
  cleaned = cleaned
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n');

  return cleaned.trim();
}

/**
 * Determine if a node is exported
 */
function isExported(node: Parser.SyntaxNode): boolean {
  // Check if parent is an export statement
  const parent = node.parent;
  if (parent?.type === 'export_statement') {
    return true;
  }

  // Check grandparent for variable declarations
  const grandparent = parent?.parent;
  if (grandparent?.type === 'export_statement') {
    return true;
  }

  // Check great-grandparent for variable declarators
  const greatGrandparent = grandparent?.parent;
  if (greatGrandparent?.type === 'export_statement') {
    return true;
  }

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
 * Parse all TypeScript/JavaScript files in a directory recursively
 *
 * @param dirPath - Path to the directory to parse
 * @param options - Optional parse options for error logging and verbose mode
 * @returns Array of ParseResult for each TypeScript/JavaScript file
 */
export async function parseTypeScriptDirectory(
  dirPath: string,
  options?: ParseOptions
): Promise<ParseResult[]> {
  const results: ParseResult[] = [];
  const tsFiles = findTypeScriptFiles(dirPath);
  const totalFiles = tsFiles.length;

  // Clear the error log file if it exists and options specify a path
  if (options?.errorLogPath) {
    try {
      fs.writeFileSync(options.errorLogPath, '');
    } catch {
      // Silently ignore errors clearing the log file
    }
  }

  for (let i = 0; i < tsFiles.length; i++) {
    const filePath = tsFiles[i];

    // Verbose progress logging every 100 files
    if (options?.verbose && (i + 1) % 100 === 0) {
      console.log(`Parsed ${i + 1}/${totalFiles} TypeScript/JavaScript files...`);
    }

    const result = await parseTypeScriptFile(filePath);
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
    console.log(`Completed parsing ${totalFiles} TypeScript/JavaScript files.`);
  }

  return results;
}

/**
 * Recursively find all TypeScript/JavaScript files in a directory
 */
function findTypeScriptFiles(dirPath: string): string[] {
  const files: string[] = [];
  const validExtensions = ['.ts', '.tsx', '.js', '.jsx'];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Skip hidden directories and common non-source directories
        if (
          !entry.name.startsWith('.') &&
          entry.name !== 'node_modules' &&
          entry.name !== 'dist' &&
          entry.name !== 'build' &&
          entry.name !== 'coverage' &&
          entry.name !== '.next' &&
          entry.name !== 'out'
        ) {
          files.push(...findTypeScriptFiles(fullPath));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (validExtensions.includes(ext)) {
          // Skip declaration files and test files if needed
          if (!entry.name.endsWith('.d.ts')) {
            files.push(fullPath);
          }
        }
      }
    }
  } catch (err) {
    // Silently skip directories we can't read
  }

  return files;
}

/**
 * Get the module name from a file path
 * e.g., /path/to/project/src/components/Button.tsx -> src/components/Button
 */
export function getModuleName(filePath: string, rootPath: string): string {
  const relativePath = path.relative(rootPath, filePath);
  const withoutExt = relativePath.replace(/\.(ts|tsx|js|jsx)$/, '');
  const moduleName = withoutExt.replace(/\//g, '/').replace(/\\/g, '/');

  // Handle index files
  if (moduleName.endsWith('/index')) {
    return moduleName.slice(0, -6);
  }

  return moduleName;
}
