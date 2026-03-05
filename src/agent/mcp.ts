/**
 * MCP (Model Context Protocol) client implementation.
 * Supports connecting to MCP servers via stdio transport (spawning a process)
 * and discovering/calling tools exposed by those servers.
 *
 * Protocol reference: https://modelcontextprotocol.io/
 */

import * as cp from "child_process";
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

  constructor(config: McpServerConfig) {
    this._config = config;
    this._serverName = config.name;
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
        console.log(`[MCP:${this._serverName}:stderr] ${text}`);
      }
    });

    this.process.on("error", (err) => {
      console.error(`[MCP:${this._serverName}] Process error:`, err.message);
      this._connected = false;
      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error(`MCP server "${this._serverName}" process error: ${err.message}`));
      }
      this.pendingRequests.clear();
    });

    this.process.on("close", (code) => {
      console.log(`[MCP:${this._serverName}] Process exited with code ${code}`);
      this._connected = false;
      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error(`MCP server "${this._serverName}" process exited with code ${code}`));
      }
      this.pendingRequests.clear();
    });

    // Perform MCP initialization handshake
    try {
      const initResult = await this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "ollama-agent-vscode",
          version: "0.0.1",
        },
      }) as { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo?: { name: string; version?: string } };

      console.log(`[MCP:${this._serverName}] Initialized:`, JSON.stringify(initResult));

      // Send initialized notification
      this.sendNotification("notifications/initialized", {});

      this._connected = true;

      // Discover available tools
      await this.refreshTools();
    } catch (err) {
      this.disconnect();
      throw new Error(
        `Failed to initialize MCP server "${this._serverName}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Refresh the list of available tools from the server.
   */
  async refreshTools(): Promise<McpToolDefinition[]> {
    if (!this._connected) {
      throw new Error(`MCP server "${this._serverName}" is not connected.`);
    }

    const result = await this.sendRequest("tools/list", {}) as {
      tools: McpToolDefinition[];
    };

    this._tools = result.tools || [];
    console.log(`[MCP:${this._serverName}] Discovered ${this._tools.length} tools:`,
      this._tools.map(t => t.name).join(", "));

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

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request to "${this._serverName}" timed out (method: ${method})`));
        }
      }, 30_000);
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

// ── MCP Manager ─────────────────────────────────────────────────────────────

/**
 * Manages multiple MCP server connections.
 * Reads configuration from VS Code settings and provides
 * a unified interface for tool discovery and execution.
 */
export class McpManager {
  private clients = new Map<string, McpClient>();
  private _outputChannel: vscode.OutputChannel | null = null;
  private _disabledTools = new Set<string>(); // Format: "serverName:toolName"

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
        this.log(`Connecting to MCP server: ${serverConfig.name} (${serverConfig.command} ${(serverConfig.args || []).join(" ")})`);
        const client = new McpClient(serverConfig);
        await client.connect();
        this.clients.set(serverConfig.name, client);
        this.log(`✅ Connected to "${serverConfig.name}" — ${client.tools.length} tool(s) available: ${client.tools.map(t => t.name).join(", ")}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`❌ Failed to connect to "${serverConfig.name}": ${message}`);
        vscode.window.showWarningMessage(`MCP server "${serverConfig.name}" failed to connect: ${message}`);
      }
    }
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
   * Find which server provides a given tool name.
   * If multiple servers provide the same tool name, returns the first match.
   */
  findToolServer(toolName: string): { serverName: string; tool: McpToolDefinition } | undefined {
    for (const [serverName, client] of this.clients) {
      if (client.connected) {
        const tool = client.tools.find(t => t.name === toolName);
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
      "The following additional tools are available from connected MCP servers.",
      'Use them with the "mcp_tool" action type.',
      "",
    ];

    // Group tools by server
    const byServer = new Map<string, Array<{ tool: McpToolDefinition }>>();
    for (const entry of allTools) {
      const existing = byServer.get(entry.serverName) || [];
      existing.push({ tool: entry.tool });
      byServer.set(entry.serverName, existing);
    }

    for (const [serverName, tools] of byServer) {
      lines.push(`### Server: ${serverName}`);
      for (const { tool } of tools) {
        lines.push(`- **${tool.name}**: ${tool.description || "(no description)"}`);
        if (tool.inputSchema?.properties) {
          const props = tool.inputSchema.properties;
          const required = new Set(tool.inputSchema.required || []);
          const paramLines: string[] = [];
          for (const [propName, propSchema] of Object.entries(props)) {
            const req = required.has(propName) ? " (required)" : " (optional)";
            const desc = propSchema.description || "";
            const type = propSchema.type || "any";
            paramLines.push(`    - \`${propName}\` (${type}${req}): ${desc}`);
          }
          if (paramLines.length > 0) {
            lines.push("  Parameters:");
            lines.push(...paramLines);
          }
        }
      }
      lines.push("");
    }

    lines.push('To call an MCP tool, use this action format:');
    lines.push('```');
    lines.push('{ "tool": "mcp_tool", "server": "<server_name>", "name": "<tool_name>", "arguments": { ... } }');
    lines.push('```');
    lines.push("");

    return lines.join("\n");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}
