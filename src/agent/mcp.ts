/**
 * MCP (Model Context Protocol) client implementation.
 * Supports connecting to MCP servers via stdio transport (spawning a process)
 * and discovering/calling tools exposed by those servers.
 *
 * Protocol reference: https://modelcontextprotocol.io/
 */

import * as cp from "child_process";
import * as net from "net";
import * as vscode from "vscode";

// ── MCP Protocol Types ──────────────────────────────────────────────────────

/** JSON-RPC 2.0 request */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 notification (no id) */
interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** MCP tool definition returned by tools/list */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type: "object";
    properties?: Record<string, McpToolPropertySchema>;
    required?: string[];
  };
}

export interface McpServerSummary {
  name: string;
  enabled: boolean;
  connected: boolean;
  transport: "stdio" | "tcp";
  command?: string;
  args?: string[];
  host?: string;
  port?: number;
  toolCount: number;
}

export interface McpServerConfigUpdateResult {
  action: "upsert" | "remove" | "reload";
  name?: string;
  existed?: boolean;
  removed?: boolean;
  reloaded: boolean;
  connected?: boolean;
  connectedCount: number;
  toolCount: number;
  server?: McpServerSummary;
  servers?: McpServerSummary[];
}

export interface McpToolSummary {
  serverName: string;
  name: string;
  enabled: boolean;
  description?: string;
  required?: string[];
  properties?: Array<{
    name: string;
    type?: string;
    description?: string;
    enum?: string[];
  }>;
}

/** JSON Schema property descriptor for tool parameters */
export interface McpToolPropertySchema {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: McpToolPropertySchema;
  [key: string]: unknown;
}

/** Result from calling an MCP tool */
export interface McpToolCallResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/** Configuration for a single MCP server */
export interface McpServerConfig {
  /** Display name for the server */
  name: string;
  /** Command to launch the server (stdio transport) */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Working directory for the server process */
  cwd?: string;
  /** Whether this server is enabled (default: true) */
  enabled?: boolean;
  /** Transport type: 'stdio' to spawn a process, or 'tcp' to connect to host:port */
  transport?: "stdio" | "tcp";
  /** TCP host (when transport === 'tcp') */
  host?: string;
  /** TCP port (when transport === 'tcp') */
  port?: number;
  /** Optional per-server request timeout in milliseconds (defaults to 30000) */
  timeoutMs?: number;
  /** Timeout for the initial connect/handshake in milliseconds (defaults to 120000).
   *  Set higher for servers that need to download packages on first run (e.g. npx -y …). */
  connectTimeoutMs?: number;
}

// ── MCP Client ──────────────────────────────────────────────────────────────

/**
 * Client for a single MCP server using stdio transport.
 * Manages the lifecycle of the server process and provides
 * methods to list and call tools.
 */
export class McpClient {
  private process: cp.ChildProcess | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();
  private buffer = "";
  private _tools: McpToolDefinition[] = [];
  private _connected = false;
  private _serverName: string;
  private _config: McpServerConfig;
  private _outputChannel: vscode.OutputChannel | null = null;

  constructor(config: McpServerConfig, outputChannel?: vscode.OutputChannel | null) {
    this._config = config;
    this._serverName = config.name;
    this._outputChannel = outputChannel || null;
  }

  get serverName(): string {
    return this._serverName;
  }

  get connected(): boolean {
    return this._connected;
  }

  get tools(): McpToolDefinition[] {
    return this._tools;
  }

  /**
   * Start the MCP server process and perform the initialization handshake.
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    const env = { ...process.env, ...(this._config.env || {}) };
    const cwd = this._config.cwd || workspaceRoot() || process.cwd();

      try {
      this.process = cp.spawn(this._config.command, this._config.args || [], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // Use a shell on Windows so commands like `npx` resolve correctly
        shell: process.platform === "win32",
      });
    } catch (err) {
      throw new Error(
        `Failed to start MCP server "${this._serverName}": ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`MCP server "${this._serverName}" has no stdio streams.`);
    }

    // Listen for data on stdout (JSON-RPC messages)
    this.process.stdout.on("data", (data: Buffer) => {
      this.handleData(data.toString("utf-8"));
    });

    // Log stderr for debugging
    this.process.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf-8").trim();
      if (text) {
        const line = `[MCP:${this._serverName}:stderr] ${text}`;
        try { this._outputChannel?.appendLine(line); } catch {}
        try { console.log(line); } catch {}
      }
    });

    this.process.on("error", (err) => {
      const line = `[MCP:${this._serverName}] Process error: ${err.message}`;
      try { this._outputChannel?.appendLine(line); } catch {}
      try { console.error(line); } catch {}
      this._connected = false;
      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error(`MCP server "${this._serverName}" process error: ${err.message}`));
      }
      this.pendingRequests.clear();
    });

    this.process.on("close", (code) => {
      const line = `[MCP:${this._serverName}] Process exited with code ${code}`;
      try { this._outputChannel?.appendLine(line); } catch {}
      try { console.log(line); } catch {}
      this._connected = false;
      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error(`MCP server "${this._serverName}" process exited with code ${code}`));
      }
      this.pendingRequests.clear();
    });

    // Perform MCP initialization handshake.
    // Use a longer timeout here — npx -y may need to download the package on first run
    // which can take a minute or more on a slow connection.
    const savedTimeoutMs = this._config.timeoutMs;
    this._config = { ...this._config, timeoutMs: this._config.connectTimeoutMs ?? 120_000 };
    try {
      const initResult = await this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "ollama-agent-vscode",
          version: "0.0.1",
        },
      }) as { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo?: { name: string; version?: string } };

      try { this._outputChannel?.appendLine(`[MCP:${this._serverName}] Initialized: ${JSON.stringify(initResult)}`); } catch {}
      try { console.log(`[MCP:${this._serverName}] Initialized:`, JSON.stringify(initResult)); } catch {}

      // Send initialized notification
      this.sendNotification("notifications/initialized", {});

      this._connected = true;
      // Restore the normal per-request timeout now that we are connected.
      this._config = { ...this._config, timeoutMs: savedTimeoutMs };

      // Discover available tools
      await this.refreshTools();
    } catch (err) {
      this._config = { ...this._config, timeoutMs: savedTimeoutMs };
      this.disconnect();
      throw new Error(
        `Failed to initialize MCP server "${this._serverName}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Refresh the list of available tools from the server.
   * Follows nextCursor pagination to collect all available tools.
   */
  async refreshTools(): Promise<McpToolDefinition[]> {
    if (!this._connected) {
      throw new Error(`MCP server "${this._serverName}" is not connected.`);
    }

    const allTools: McpToolDefinition[] = [];
    let cursor: string | undefined;

    do {
      const params: Record<string, unknown> = cursor ? { cursor } : {};
      const result = await this.sendRequest("tools/list", params) as {
        tools?: McpToolDefinition[];
        nextCursor?: string;
      };
      allTools.push(...(result.tools || []));
      cursor = result.nextCursor;
    } while (cursor);

    this._tools = allTools;
    const line = `[MCP:${this._serverName}] Discovered ${this._tools.length} tools: ${this._tools.map(t => t.name).join(", ")}`;
    try { this._outputChannel?.appendLine(line); } catch {}
    try { console.log(line); } catch {}

    return this._tools;
  }

  /**
   * Call a tool on the MCP server.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (!this._connected) {
      throw new Error(`MCP server "${this._serverName}" is not connected.`);
    }

    const result = await this.sendRequest("tools/call", {
      name: toolName,
      arguments: args,
    }) as McpToolCallResult;

    return result;
  }

  /**
   * Disconnect from the MCP server and kill the process.
   */
  disconnect(): void {
    this._connected = false;
    this._tools = [];

    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // Process may already be dead
      }
      this.process = null;
    }

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error(`MCP server "${this._serverName}" disconnected.`));
    }
    this.pendingRequests.clear();
  }

  // ── Private methods ─────────────────────────────────────────────────────

  /**
   * Handle incoming data from the server's stdout.
   * MCP uses newline-delimited JSON-RPC messages.
   */
  private handleData(data: string): void {
    this.buffer += data;

    // Process complete lines
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      try {
        const message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;

        if ("id" in message && message.id !== undefined) {
          // This is a response to one of our requests
          const response = message as JsonRpcResponse;
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);
            if (response.error) {
              pending.reject(new Error(
                `MCP error ${response.error.code}: ${response.error.message}`
              ));
            } else {
              pending.resolve(response.result);
            }
          }
        } else {
          // This is a notification from the server
          const notification = message as JsonRpcNotification;
          console.log(`[MCP:${this._serverName}] Notification: ${notification.method}`);
        }
      } catch {
        // Skip malformed JSON lines
        console.warn(`[MCP:${this._serverName}] Malformed message: ${line.slice(0, 200)}`);
      }
    }
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error(`MCP server "${this._serverName}" stdin not available.`));
        return;
      }

      const id = this.nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, { resolve, reject });

      const message = JSON.stringify(request) + "\n";
      try {
        this.process.stdin.write(message, "utf-8", (err) => {
          if (err) {
            this.pendingRequests.delete(id);
            reject(new Error(`Failed to write to MCP server "${this._serverName}": ${err.message}`));
          }
        });
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(new Error(
          `Failed to send to MCP server "${this._serverName}": ${err instanceof Error ? err.message : String(err)}`
        ));
      }

      // Timeout (configurable per-server, default 30s)
      const timeoutMs = this._config.timeoutMs ?? 30_000;
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request to "${this._serverName}" timed out (method: ${method})`));
        }
      }, timeoutMs);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.process?.stdin) {
      return;
    }

    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const message = JSON.stringify(notification) + "\n";
    try {
      this.process.stdin.write(message, "utf-8");
    } catch {
      // Ignore write errors for notifications
    }
  }
}

/**
 * MCP client that connects to an already-running MCP server over TCP.
 * Useful when the server is started externally (e.g. Playwright MCP server).
 */
export class TcpMcpClient {
  private socket: net.Socket | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();
  private buffer = "";
  private _tools: McpToolDefinition[] = [];
  private _connected = false;
  private _serverName: string;
  private _config: McpServerConfig;
  private _outputChannel: vscode.OutputChannel | null = null;

  constructor(config: McpServerConfig, outputChannel?: vscode.OutputChannel | null) {
    this._config = config;
    this._serverName = config.name;
    this._outputChannel = outputChannel || null;
  }

  get serverName(): string { return this._serverName; }
  get connected(): boolean { return this._connected; }
  get tools(): McpToolDefinition[] { return this._tools; }

  async connect(): Promise<void> {
    if (this._connected) return;

    const host = this._config.host || "127.0.0.1";
    const port = this._config.port;
    if (!port) {
      throw new Error(`MCP server "${this._serverName}" tcp port not specified.`);
    }

    this.socket = new net.Socket();

    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this._connected = false;
        reject(new Error(`Failed to connect to MCP server "${this._serverName}" at ${host}:${port}: ${err.message}`));
      };

      this.socket!.once("error", onError);

      this.socket!.connect(port, host, async () => {
        this.socket!.removeListener("error", onError);

        this.socket!.on("data", (data: Buffer) => this.handleData(data.toString("utf-8")));
        this.socket!.on("close", () => {
          const line = `[MCP:${this._serverName}] TCP socket closed`;
          try { this._outputChannel?.appendLine(line); } catch {}
          try { console.log(line); } catch {}
          this._connected = false;
        });

        const savedConnectTimeoutMs = this._config.timeoutMs;
        this._config = { ...this._config, timeoutMs: this._config.connectTimeoutMs ?? 120_000 };
        try {
          const initResult = await this.sendRequest("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "ollama-agent-vscode", version: "0.0.1" }
          }) as { protocolVersion: string };

          this.sendNotification("notifications/initialized", {});
          this._connected = true;
          this._config = { ...this._config, timeoutMs: savedConnectTimeoutMs };
          try { this._outputChannel?.appendLine(`[MCP:${this._serverName}] Initialized (tcp)`); } catch {}
          await this.refreshTools();
          resolve();
        } catch (err) {
          this._config = { ...this._config, timeoutMs: savedConnectTimeoutMs };
          this.disconnect();
          reject(new Error(`Failed to initialize MCP server "${this._serverName}": ${err instanceof Error ? err.message : String(err)}`));
        }
      });
    });
  }

  async refreshTools(): Promise<McpToolDefinition[]> {
    if (!this._connected) throw new Error(`MCP server "${this._serverName}" is not connected.`);
    const allTools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const params: Record<string, unknown> = cursor ? { cursor } : {};
      const result = await this.sendRequest("tools/list", params) as { tools?: McpToolDefinition[]; nextCursor?: string };
      allTools.push(...(result.tools || []));
      cursor = result.nextCursor;
    } while (cursor);
    this._tools = allTools;
    return this._tools;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (!this._connected) throw new Error(`MCP server "${this._serverName}" is not connected.`);
    const result = await this.sendRequest("tools/call", { name: toolName, arguments: args }) as McpToolCallResult;
    return result;
  }

  disconnect(): void {
    this._connected = false;
    this._tools = [];
    if (this.socket) {
      try { this.socket.end(); this.socket.destroy(); } catch {}
      this.socket = null;
    }
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error(`MCP server "${this._serverName}" disconnected.`));
    }
    this.pendingRequests.clear();
  }

  private handleData(data: string): void {
    this.buffer += data;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
        if ("id" in message && message.id !== undefined) {
          const response = message as JsonRpcResponse;
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);
            if (response.error) {
              pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
            } else {
              pending.resolve(response.result);
            }
          }
        } else {
          // notification
        }
      } catch {
        // ignore
      }
    }
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket) { reject(new Error(`MCP server "${this._serverName}" socket not available.`)); return; }
      const id = this.nextId++;
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.pendingRequests.set(id, { resolve, reject });
      const message = JSON.stringify(request) + "\n";
      try {
        this.socket.write(message, "utf-8", (err) => {
          if (err) {
            this.pendingRequests.delete(id);
            reject(new Error(`Failed to write to MCP server "${this._serverName}": ${err.message}`));
          }
        });
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(new Error(`Failed to send to MCP server "${this._serverName}": ${err instanceof Error ? err.message : String(err)}`));
      }
      const timeoutMs = this._config.timeoutMs ?? 30_000;
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request to "${this._serverName}" timed out (method: ${method})`));
        }
      }, timeoutMs);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.socket) return;
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    try { this.socket.write(JSON.stringify(notification) + "\n", "utf-8"); } catch {}
  }
}

// ── MCP Manager ─────────────────────────────────────────────────────────────

/**
 * Manages multiple MCP server connections.
 * Reads configuration from VS Code settings and provides
 * a unified interface for tool discovery and execution.
 */
export class McpManager {
  private clients = new Map<string, any>();
  private _outputChannel: vscode.OutputChannel | null = null;
  private _disabledTools = new Set<string>(); // Format: "serverName:toolName"

  private readonly _onDidLoad = new vscode.EventEmitter<void>();
  /** Fires each time `loadFromSettings()` completes (success or error). */
  public readonly onDidLoad: vscode.Event<void> = this._onDidLoad.event;

  set outputChannel(channel: vscode.OutputChannel) {
    this._outputChannel = channel;
  }

  /**
   * Load disabled tools from VS Code settings
   */
  private async loadDisabledTools(): Promise<void> {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const disabled = config.get<string[]>("mcpDisabledTools", []);
    this._disabledTools = new Set(disabled);
  }

  /**
   * Save disabled tools to VS Code settings
   */
  private async saveDisabledTools(): Promise<void> {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    await config.update("mcpDisabledTools", Array.from(this._disabledTools), vscode.ConfigurationTarget.Workspace);
  }

  /**
   * Check if a specific tool is disabled
   */
  isToolDisabled(serverName: string, toolName: string): boolean {
    return this._disabledTools.has(`${serverName}:${toolName}`);
  }

  /**
   * Toggle a tool on/off
   */
  async toggleTool(serverName: string, toolName: string, enabled: boolean): Promise<void> {
    const key = `${serverName}:${toolName}`;
    if (enabled) {
      this._disabledTools.delete(key);
    } else {
      this._disabledTools.add(key);
    }
    await this.saveDisabledTools();
  }

  private log(message: string): void {
    if (this._outputChannel) {
      this._outputChannel.appendLine(`[MCP] ${message}`);
    }
    console.log(`[MCP] ${message}`);
  }

  /**
   * Load MCP server configurations from VS Code settings and connect to them.
   */
  async loadFromSettings(): Promise<void> {
    // Load disabled tools first
    await this.loadDisabledTools();
    
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const servers = config.get<McpServerConfig[]>("mcpServers", []);

    // Disconnect any existing clients
    this.disconnectAll();

    for (const serverConfig of servers) {
      if (serverConfig.enabled === false) {
        this.log(`Skipping disabled MCP server: ${serverConfig.name}`);
        continue;
      }

      try {
        if (serverConfig.transport === "tcp") {
          this.log(`Connecting to MCP server (tcp): ${serverConfig.name} (${serverConfig.host || '127.0.0.1'}:${serverConfig.port})`);
          const client = new TcpMcpClient(serverConfig, this._outputChannel);
          await client.connect();
          this.clients.set(serverConfig.name, client as any);
          this.log(`✅ Connected to "${serverConfig.name}" — ${client.tools.length} tool(s) available: ${client.tools.map(t => t.name).join(", ")}`);
        } else {
          this.log(`Connecting to MCP server: ${serverConfig.name} (${serverConfig.command} ${(serverConfig.args || []).join(" ")})`);
          const client = new McpClient(serverConfig, this._outputChannel);
          await client.connect();
          this.clients.set(serverConfig.name, client as any);
          this.log(`✅ Connected to "${serverConfig.name}" — ${client.tools.length} tool(s) available: ${client.tools.map(t => t.name).join(", ")}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`❌ Failed to connect to "${serverConfig.name}": ${message}`);
        // Helpful Windows fallback: if spawn npx ENOENT, retry with npx.cmd or via cmd /c
        if (process.platform === "win32" && serverConfig.transport !== "tcp") {
          const isNpx = serverConfig.command === "npx" || serverConfig.command === "npx.cmd";
          if (isNpx && /spawn npx ENOENT/i.test(message)) {
            try {
              this.log(`Attempting Windows fallback: retrying with npx.cmd for "${serverConfig.name}"`);
              const fixed = { ...serverConfig, command: "npx.cmd" } as McpServerConfig;
              const client2 = new McpClient(fixed, this._outputChannel);
              await client2.connect();
              this.clients.set(serverConfig.name, client2 as any);
              this.log(`✅ Connected to "${serverConfig.name}" via npx.cmd — ${client2.tools.length} tool(s) available`);
              continue;
            } catch (err2) {
              const msg2 = err2 instanceof Error ? err2.message : String(err2);
              this.log(`Windows fallback npx.cmd also failed: ${msg2}`);
            }
            // Try shelling through cmd /c as a last resort
            try {
              this.log(`Attempting Windows fallback: running via cmd /c for "${serverConfig.name}"`);
              const joined = [serverConfig.command].concat(serverConfig.args || []).join(" ");
              const shellCfg: McpServerConfig = { ...serverConfig, command: "cmd", args: ["/c", joined] };
              const client3 = new McpClient(shellCfg, this._outputChannel);
              await client3.connect();
              this.clients.set(serverConfig.name, client3 as any);
              this.log(`✅ Connected to "${serverConfig.name}" via cmd /c — ${client3.tools.length} tool(s) available`);
              continue;
            } catch (err3) {
              this.log(`Windows fallback cmd /c failed: ${err3 instanceof Error ? err3.message : String(err3)}`);
            }
          }
        }
        vscode.window.showWarningMessage(`MCP server "${serverConfig.name}" failed to connect: ${message}`);
      }
    }

    // Notify subscribers that loading is complete (whether or not all servers connected).
    this._onDidLoad.fire();
  }

  /**
   * Get all available MCP tools across all connected servers.
   * Returns tools prefixed with the server name for disambiguation.
   * Does not include disabled tools.
   */
  getAllTools(): Array<{ serverName: string; tool: McpToolDefinition }> {
    const allTools: Array<{ serverName: string; tool: McpToolDefinition }> = [];
    for (const [serverName, client] of this.clients) {
      if (client.connected) {
        for (const tool of client.tools) {
          if (!this.isToolDisabled(serverName, tool.name)) {
            allTools.push({ serverName, tool });
          }
        }
      }
    }
    return allTools;
  }

  /**
   * Get all tools including disabled ones with their status
   */
  getAllToolsWithStatus(): Array<{ serverName: string; tool: McpToolDefinition; enabled: boolean }> {
    const allTools: Array<{ serverName: string; tool: McpToolDefinition; enabled: boolean }> = [];
    for (const [serverName, client] of this.clients) {
      if (client.connected) {
        for (const tool of client.tools) {
          const enabled = !this.isToolDisabled(serverName, tool.name);
          allTools.push({ serverName, tool, enabled });
        }
      }
    }
    return allTools;
  }

  getServerSummaries(): McpServerSummary[] {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const servers = config.get<McpServerConfig[]>("mcpServers", []);

    return servers.map((server) => {
      const client = this.clients.get(server.name);
      const connected = client?.connected === true;
      const toolCount = connected && Array.isArray(client?.tools) ? client.tools.length : 0;

      return {
        name: server.name,
        enabled: server.enabled !== false,
        connected,
        transport: server.transport === "tcp" ? "tcp" : "stdio",
        command: server.command,
        args: server.args,
        host: server.host,
        port: server.port,
        toolCount,
      };
    });
  }

  getToolSummaries(serverName?: string, includeDisabled = false): McpToolSummary[] {
    const tools = includeDisabled ? this.getAllToolsWithStatus() : this.getAllTools().map((entry) => ({ ...entry, enabled: true }));

    return tools
      .filter((entry) => !serverName || entry.serverName === serverName)
      .map((entry) => {
        const properties = Object.entries(entry.tool.inputSchema?.properties || {}).map(([name, schema]) => ({
          name,
          type: typeof schema.type === "string" ? schema.type : undefined,
          description: typeof schema.description === "string" ? schema.description : undefined,
          enum: Array.isArray(schema.enum)
            ? schema.enum.filter((value): value is string => typeof value === "string")
            : undefined,
        }));

        return {
          serverName: entry.serverName,
          name: entry.tool.name,
          enabled: entry.enabled,
          description: entry.tool.description,
          required: Array.isArray(entry.tool.inputSchema?.required) ? entry.tool.inputSchema.required : [],
          properties,
        };
      });
  }

  async upsertServerConfig(serverConfig: McpServerConfig, connect = true): Promise<McpServerConfigUpdateResult> {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const servers = config.get<McpServerConfig[]>("mcpServers", []);
    const nextConfig: McpServerConfig = {
      ...serverConfig,
      name: serverConfig.name.trim(),
      command: serverConfig.command.trim(),
      args: serverConfig.args?.filter((value) => value.trim().length > 0),
      cwd: serverConfig.cwd?.trim() || undefined,
      enabled: serverConfig.enabled !== false,
    };

    const existingIndex = servers.findIndex((server) => server.name === nextConfig.name);
    const existed = existingIndex >= 0;
    if (existed) {
      servers[existingIndex] = nextConfig;
    } else {
      servers.push(nextConfig);
    }

    await config.update("mcpServers", servers, vscode.ConfigurationTarget.Workspace);

    if (connect) {
      await this.loadFromSettings();
    }

    const summaries = this.getServerSummaries();
    const summary = summaries.find((server) => server.name === nextConfig.name);

    return {
      action: "upsert",
      name: nextConfig.name,
      existed,
      reloaded: connect,
      connected: summary?.connected,
      connectedCount: this.connectedCount,
      toolCount: this.getAllTools().length,
      server: summary,
      servers: summaries,
    };
  }

  async removeServerConfig(serverName: string, reload = true): Promise<McpServerConfigUpdateResult> {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const servers = config.get<McpServerConfig[]>("mcpServers", []);
    const nextServers = servers.filter((server) => server.name !== serverName);
    const removed = nextServers.length !== servers.length;

    if (removed) {
      await config.update("mcpServers", nextServers, vscode.ConfigurationTarget.Workspace);
    }

    if (reload) {
      await this.loadFromSettings();
    }

    return {
      action: "remove",
      name: serverName,
      removed,
      reloaded: reload,
      connectedCount: this.connectedCount,
      toolCount: this.getAllTools().length,
      servers: this.getServerSummaries(),
    };
  }

  async reloadServers(): Promise<McpServerConfigUpdateResult> {
    await this.loadFromSettings();
    return {
      action: "reload",
      reloaded: true,
      connectedCount: this.connectedCount,
      toolCount: this.getAllTools().length,
      servers: this.getServerSummaries(),
    };
  }

  /**
   * Call a tool on a specific MCP server.
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server "${serverName}" not found.`);
    }
    if (!client.connected) {
      throw new Error(`MCP server "${serverName}" is not connected.`);
    }
    return client.callTool(toolName, args);
  }

  /**
   * Fetch raw tools list from a specific server (useful for debugging).
   */
  async fetchToolsRaw(serverName: string): Promise<McpToolDefinition[] | undefined> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server "${serverName}" not found.`);
    }
    if (!client.connected) {
      throw new Error(`MCP server "${serverName}" is not connected.`);
    }
    // client.refreshTools returns the tools array
    return (await client.refreshTools()) as McpToolDefinition[];
  }

  /**
   * Find which server provides a given tool name.
   * If multiple servers provide the same tool name, returns the first match.
   */
  findToolServer(toolName: string): { serverName: string; tool: McpToolDefinition } | undefined {
    for (const [serverName, client] of this.clients) {
      if (client.connected) {
        const tool = client.tools.find((t: McpToolDefinition) => t.name === toolName);
        if (tool) {
          return { serverName, tool };
        }
      }
    }
    return undefined;
  }

  /**
   * Disconnect all MCP servers.
   */
  disconnectAll(): void {
    for (const [name, client] of this.clients) {
      this.log(`Disconnecting MCP server: ${name}`);
      client.disconnect();
    }
    this.clients.clear();
  }

  /**
   * Get the number of connected servers.
   */
  get connectedCount(): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.connected) {
        count++;
      }
    }
    return count;
  }

  /**
   * Returns true if the named server has an active connection.
   */
  isServerConnected(serverName: string): boolean {
    const client = this.clients.get(serverName);
    return client !== undefined && client.connected === true;
  }

  /**
   * Build a description of all available MCP tools for inclusion in the system prompt.
   * Returns an empty string if no MCP tools are available.
   */
  buildToolsDescription(): string {
    const allTools = this.getAllTools();
    if (allTools.length === 0) {
      return "";
    }

    const lines: string[] = [
      "",
      "## MCP Server Tools",
      'Use them with the "mcp_tool" action type.',
      '{ "tool": "mcp_tool", "server": "<server_name>", "name": "<tool_name>", "arguments": { ... } }',
      "",
    ];

    const byServer = new Map<string, Array<{ tool: McpToolDefinition }>>();
    for (const entry of allTools) {
      const existing = byServer.get(entry.serverName) || [];
      existing.push({ tool: entry.tool });
      byServer.set(entry.serverName, existing);
    }

    for (const [serverName, tools] of byServer) {
      lines.push(`Server ${serverName}:`);
      for (const { tool } of tools) {
        const requiredProps = Array.isArray(tool.inputSchema?.required)
          ? tool.inputSchema.required.join(", ")
          : "";
        const propNames = tool.inputSchema?.properties
          ? Object.keys(tool.inputSchema.properties).slice(0, 6).join(", ")
          : "";
        const details = [requiredProps ? `required: ${requiredProps}` : "", propNames ? `args: ${propNames}` : ""]
          .filter(Boolean)
          .join("; ");
        lines.push(`- ${tool.name}${details ? ` (${details})` : ""}`);
        if (tool.description) {
          lines.push(`  ${tool.description}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  buildAgentContextDescription(): string {
    const summaries = this.getServerSummaries();
    const lines: string[] = ["", "## MCP Availability"];

    if (summaries.length === 0) {
      lines.push("No MCP servers are configured right now.");
      lines.push('You may add one with the "upsert_mcp_server" action and connect it with "reload_mcp_servers" after creating any needed files.');
      return lines.join("\n");
    }

    lines.push("Configured MCP servers:");
    for (const server of summaries) {
      const transport = server.transport === "tcp"
        ? `tcp ${server.host || "127.0.0.1"}:${server.port ?? "?"}`
        : `${server.command || "?"}${server.args?.length ? ` ${server.args.join(" ")}` : ""}`;
      lines.push(`- ${server.name}: ${server.connected ? "connected" : "not connected"}; enabled=${server.enabled}; tools=${server.toolCount}; transport=${transport}`);
    }

    const toolsDescription = this.buildToolsDescription();
    if (toolsDescription) {
      lines.push(toolsDescription);
    } else {
      lines.push("");
      lines.push("No enabled MCP tools are currently available from connected servers.");
      lines.push('If a server should expose tools, inspect it with "list_mcp_tools" or reconnect with "reload_mcp_servers".');
    }

    return lines.join("\n");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}
