/**
 * Agentifind Type Definitions
 *
 * Simplified types for the new codebase.json output format.
 * The tool extracts code structure and outputs a single JSON file
 * that AI agents can read directly.
 */

// =============================================================================
// Basic Types
// =============================================================================

/** Absolute or relative path to a file */
export type FilePath = string;

/** Unique identifier for a symbol (typically: file:name:line) */
export type SymbolId = string;

// =============================================================================
// Codebase Index - Main Output Structure
// =============================================================================

/** Class information in the codebase index */
export interface ClassInfo {
  methods: string[];
  inherits: string[];
  line: number;
}

/** Function information in the codebase index */
export interface FunctionInfo {
  calls: string[];
  called_by: string[];
  line: number;
}

/** Module (file) information in the codebase index */
export interface ModuleInfo {
  imports: string[];
  exports: string[];
  classes: Record<string, ClassInfo>;
  functions: Record<string, FunctionInfo>;
}

/** Validation result for a single check */
export interface ValidationResult {
  status: 'pass' | 'fail' | 'skipped';
  tool: string;
  issues: Array<{
    file: string;
    line?: number;
    message: string;
  }>;
}

/** Validation report containing all checks */
export interface ValidationReport {
  linting: ValidationResult;
  formatting: ValidationResult;
  types: ValidationResult;
}

/** Detected gap in call graph (potential dynamic pattern) */
export interface AnalysisGap {
  /** Symbol or file name */
  name: string;
  /** File path where it's defined */
  file: string;
  /** Line number if applicable */
  line?: number;
  /** Why this is flagged as a gap */
  reason: string;
}

/** Analysis gaps - patterns that static analysis may not fully trace */
export interface AnalysisGaps {
  /** Exported functions with no detected callers (may be entry points or dynamically invoked) */
  uncalled_exports: AnalysisGap[];
  /** Imports that are never referenced in code (may be side-effect imports or re-exports) */
  unused_imports: AnalysisGap[];
  /** Files that are never imported (may be entry points, scripts, or dynamically loaded) */
  orphan_modules: AnalysisGap[];
}

// =============================================================================
// Infrastructure Index - For Terraform/IaC repos
// =============================================================================

/** Terraform resource in the infrastructure index */
export interface InfraResource {
  type: string;
  name: string;
  provider: string;
  file: string;
  line: number;
  dependencies: string[];
  references: string[];
}

/** Terraform module call */
export interface InfraModule {
  name: string;
  source: string;
  file: string;
  line: number;
  inputs: Record<string, string>;
}

/** Terraform variable */
export interface InfraVariable {
  name: string;
  type?: string;
  default?: string;
  description?: string;
  file: string;
  line: number;
  used_by: string[];
}

/** Terraform output */
export interface InfraOutput {
  name: string;
  value: string;
  description?: string;
  file: string;
  line: number;
  references: string[];
}

/** Blast radius analysis - what changes if you modify something */
export interface BlastRadius {
  /** The resource/module being analyzed */
  target: string;
  /** Resources that would be affected */
  affected_resources: string[];
  /** Severity: low (1-5 resources), medium (5-20), high (20+) */
  severity: 'low' | 'medium' | 'high';
}

/** Infrastructure index - output for Terraform/IaC repos */
export interface InfrastructureIndex {
  /** ISO timestamp when generated */
  generated: string;
  /** Git commit hash */
  commit: string;
  /** Repo type identifier */
  repo_type: 'terraform' | 'kubernetes' | 'ansible' | 'cloudformation';
  /** Extraction method used: lsp (terraform-ls) or regex (fallback) */
  extraction_method?: 'lsp' | 'regex';
  /** Statistics about the infrastructure */
  stats: {
    files: number;
    resources: number;
    modules: number;
    variables: number;
    outputs: number;
    providers: string[];
  };
  /** All resources by type */
  resources: Record<string, InfraResource[]>;
  /** Module calls */
  modules: InfraModule[];
  /** Variables defined */
  variables: InfraVariable[];
  /** Outputs defined */
  outputs: InfraOutput[];
  /** Resource dependency graph: resource -> resources it depends on */
  dependency_graph: Record<string, string[]>;
  /** Blast radius analysis for key resources */
  blast_radius: BlastRadius[];
}

/** Main codebase index - output of agentifind sync */
export interface CodebaseIndex {
  /** ISO timestamp when generated */
  generated: string;
  /** Git commit hash */
  commit: string;
  /** Statistics about the codebase */
  stats: {
    files: number;
    modules: number;
    functions: number;
    classes: number;
  };
  /** Per-file module information */
  modules: Record<string, ModuleInfo>;
  /** Call graph: function -> functions it calls */
  call_graph: Record<string, string[]>;
  /** Import graph: file -> modules it imports */
  import_graph: Record<string, string[]>;
  /** Analysis gaps - patterns that may indicate dynamic behavior */
  analysis_gaps?: AnalysisGaps;
  /** Validation results (optional) */
  validation?: ValidationReport;
}

// =============================================================================
// Internal Types - Used During Extraction
// =============================================================================

/** Classification of code symbols */
export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'variable'
  | 'type'
  | 'component'
  | 'hook'
  | 'interface'
  | 'type_alias'
  | 'enum'
  | 'namespace';

/** Classification of symbol references */
export type ReferenceKind =
  | 'call'
  | 'attribute'
  | 'type'
  | 'import'
  | 'framework_inject'
  | 'decorator'
  | 'callback'
  | 'unknown';

/** Complete information about a code symbol */
export interface SymbolInfo {
  id: SymbolId;
  name: string;
  kind: SymbolKind;
  file: FilePath;
  line: number;
  endLine?: number;
  exported: boolean;
  signature?: string;
  docstring?: string;
}

/** Information about a reference to a symbol */
export interface Reference {
  symbolId: SymbolId;
  file: FilePath;
  line: number;
  kind: ReferenceKind;
}

/** Information about an imported symbol with optional alias */
export interface ImportedSymbol {
  name: string;
  alias?: string;
}

/** Information about an import statement */
export interface Import {
  source: string;
  symbols: ImportedSymbol[];
  moduleAlias?: string;
  isWildcard?: boolean;
  line: number;
}

/** Information about a single source file */
export interface FileInfo {
  path: FilePath;
  language: string;
  lines: number;
  symbols: SymbolId[];
  imports: Import[];
}

/** Information about a module (directory/package) */
export interface InternalModuleInfo {
  path: string;
  files: FilePath[];
  exports: SymbolId[];
  isPublic: boolean;
}

/** Internal structure index used during extraction */
export interface StructureIndex {
  version: string;
  generated: string;
  repoRoot: string;
  languages: string[];
  files: Record<FilePath, FileInfo>;
  symbols: Record<SymbolId, SymbolInfo>;
  references: Record<SymbolId, Reference[]>;
  modules: Record<string, InternalModuleInfo>;
}

// =============================================================================
// Test Mapping (internal use)
// =============================================================================

/** Mapping between a source file and its tests */
export interface TestMapping {
  sourceFile: FilePath;
  testFiles: FilePath[];
  testFunctions: string[];
}

/** Collection of test mappings for a codebase */
export interface TestMap {
  version: string;
  mappings: TestMapping[];
}

// =============================================================================
// Entry Points (internal use)
// =============================================================================

/** An entry point into the codebase */
export interface EntryPoint {
  file: FilePath;
  symbol?: string;
  kind: 'main' | 'cli' | 'api_handler' | 'test';
  description?: string;
}

/** Collection of entry points for a codebase */
export interface EntryPoints {
  version: string;
  entries: EntryPoint[];
}

// =============================================================================
// File Relationships (internal use)
// =============================================================================

/** Types of relationships between files */
export type FileRelationship =
  | 'imports'
  | 'imported_by'
  | 'co_changes'
  | 'same_module';

// =============================================================================
// Parser Types
// =============================================================================

/** Result returned by language parsers */
export interface ParseResult {
  file: FilePath;
  language: string;
  symbols: SymbolInfo[];
  references: Reference[];
  imports: Import[];
  errors?: string[];
}

/** Options for parser functions */
export interface ParseOptions {
  errorLogPath?: string;
  verbose?: boolean;
}

// =============================================================================
// Statistics
// =============================================================================

/** Statistics about indexing results */
export interface IndexStats {
  files: {
    total: number;
    parsed: number;
    errors: number;
  };
  symbols: {
    total: number;
    functions: number;
    classes: number;
    methods: number;
    variables: number;
    types: number;
    components: number;
    hooks: number;
    interfaces: number;
    typeAliases: number;
    enums: number;
    namespaces: number;
  };
  references: {
    total: number;
    calls: number;
    imports: number;
  };
  indexSizeBytes: number;
  parseErrors: string[];
}
