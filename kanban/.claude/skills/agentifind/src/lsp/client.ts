/**
 * LSP Client - JSON-RPC over stdio
 *
 * Communicates with language servers (pyright, tsserver) using
 * the Language Server Protocol.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

export interface LSPPosition {
  line: number;
  character: number;
}

export interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

export interface LSPLocation {
  uri: string;
  range: LSPRange;
}

export interface LSPSymbolInformation {
  name: string;
  kind: number;
  location: LSPLocation;
  containerName?: string;
}

export interface LSPDocumentSymbol {
  name: string;
  kind: number;
  range: LSPRange;
  selectionRange: LSPRange;
  children?: LSPDocumentSymbol[];
}

// Symbol kinds from LSP spec
export const SymbolKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
} as const;

/**
 * Generic LSP client that communicates via JSON-RPC over stdio
 */
export class LSPClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private rawBuffer: Buffer = Buffer.alloc(0);
  private contentLength = -1;
  private initialized = false;
  private rootUri: string;

  constructor(
    private command: string,
    private args: string[],
    rootPath: string
  ) {
    this.rootUri = `file://${path.resolve(rootPath)}`;
  }

  /**
   * Start the language server process
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stdin) {
          reject(new Error('Failed to create process streams'));
          return;
        }

        // Handle incoming data
        this.process.stdout.on('data', (data: Buffer) => {
          this.handleData(data);
        });

        this.process.stderr?.on('data', (data: Buffer) => {
          // Log stderr but don't fail - some servers write info to stderr
          const msg = data.toString().trim();
          if (msg && !msg.includes('Pyright')) {
            // Suppress pyright banner
            console.error(`[LSP stderr] ${msg}`);
          }
        });

        this.process.on('error', (err) => {
          reject(err);
        });

        this.process.on('exit', (code) => {
          if (!this.initialized) {
            reject(new Error(`LSP server exited with code ${code}`));
          }
        });

        // Initialize the server
        this.initialize().then(() => {
          this.initialized = true;
          resolve();
        }).catch(reject);

      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop the language server
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    try {
      await this.request('shutdown', {});
      this.notify('exit', {});
    } catch {
      // Server might already be dead
    }

    this.process.kill();
    this.process = null;
  }

  /**
   * Handle incoming data from the server (using Buffer for byte-accurate parsing)
   */
  private handleData(data: Buffer): void {
    this.rawBuffer = Buffer.concat([this.rawBuffer, data]);

    while (true) {
      // Parse headers
      if (this.contentLength === -1) {
        const headerEnd = this.rawBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const headers = this.rawBuffer.subarray(0, headerEnd).toString('utf-8');
        const match = headers.match(/Content-Length: (\d+)/i);
        if (!match) {
          this.rawBuffer = this.rawBuffer.subarray(headerEnd + 4);
          continue;
        }

        this.contentLength = parseInt(match[1], 10);
        this.rawBuffer = this.rawBuffer.subarray(headerEnd + 4);
      }

      // Check if we have the full message (byte length)
      if (this.rawBuffer.length < this.contentLength) return;

      const messageBytes = this.rawBuffer.subarray(0, this.contentLength);
      this.rawBuffer = this.rawBuffer.subarray(this.contentLength);
      this.contentLength = -1;

      try {
        const message = messageBytes.toString('utf-8');
        const json = JSON.parse(message);
        this.handleMessage(json);
      } catch (err) {
        // Silently skip malformed messages - pyright sometimes sends partial data
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  private handleMessage(message: { id?: number; result?: unknown; error?: { message: string } }): void {
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    }
    // Ignore notifications for now
  }

  /**
   * Send a request and wait for response
   */
  async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.process?.stdin) {
      throw new Error('LSP client not started');
    }

    const id = ++this.requestId;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      this.process!.stdin!.write(content);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  /**
   * Send a notification (no response expected)
   */
  notify(method: string, params: unknown): void {
    if (!this.process?.stdin) return;

    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    this.process.stdin.write(content);
  }

  /**
   * Initialize the language server
   */
  private async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      processId: process.pid,
      rootUri: this.rootUri,
      rootPath: this.rootUri.replace('file://', ''),
      capabilities: {
        textDocument: {
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          definition: {},
          references: {},
          hover: {},
        },
        workspace: {
          symbol: {
            symbolKind: {
              valueSet: Object.values(SymbolKind),
            },
          },
        },
      },
    });

    this.notify('initialized', {});
    return;
  }

  /**
   * Get all symbols in the workspace
   */
  async workspaceSymbols(query = ''): Promise<LSPSymbolInformation[]> {
    return this.request('workspace/symbol', { query });
  }

  /**
   * Get symbols in a specific document
   */
  async documentSymbols(uri: string): Promise<LSPDocumentSymbol[] | LSPSymbolInformation[]> {
    return this.request('textDocument/documentSymbol', {
      textDocument: { uri },
    });
  }

  /**
   * Get definition of symbol at position
   */
  async definition(uri: string, position: LSPPosition): Promise<LSPLocation | LSPLocation[] | null> {
    return this.request('textDocument/definition', {
      textDocument: { uri },
      position,
    });
  }

  /**
   * Get all references to symbol at position
   */
  async references(uri: string, position: LSPPosition, includeDeclaration = true): Promise<LSPLocation[]> {
    return this.request('textDocument/references', {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    });
  }

  /**
   * Open a document (required before querying it)
   */
  openDocument(uri: string, text: string, languageId: string): void {
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text,
      },
    });
  }

  /**
   * Close a document
   */
  closeDocument(uri: string): void {
    this.notify('textDocument/didClose', {
      textDocument: { uri },
    });
  }
}

/**
 * Check if a command exists in PATH
 */
export async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}
